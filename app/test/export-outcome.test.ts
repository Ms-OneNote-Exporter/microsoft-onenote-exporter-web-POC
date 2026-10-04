import { describe, expect, it } from 'vitest';
import { classify, parseLine } from '../src/server/log-parser';
import { judgeExport, newTrace, type JobTrace } from '../src/server/flows';
import type { JobResult } from '../src/server/runner-events';

/**
 * The two 0.4.0 outcomes that the app used to report wrongly.
 *
 * Both were found by running the real package against a real notebook, and both
 * are about the app claiming more than it can support: a run that found nothing
 * read as a generic failure, and a run that wrote nothing read as a partial
 * success with a download attached.
 */

/** Feeds lines through the trace exactly as the service does. */
function traceOf(lines: string[]): JobTrace {
  const trace = newTrace();
  for (const raw of lines) {
    const parsed = parseLine(raw);
    const signal = classify(parsed.text);
    const text = parsed.text;
    switch (signal.kind) {
      case 'page-exported':
        trace.pagesExported += 1;
        break;
      case 'total-pages':
        trace.totalPages = signal.pages;
        break;
      case 'total-assets':
        break;
      case 'pages-failed':
        trace.pagesFailed = signal.pages;
        break;
      case 'files-saved-in':
        trace.reportedOutDir = signal.dir;
        break;
      case 'export-complete':
        trace.sawExportComplete = true;
        break;
      case 'export-partial':
        trace.sawExportPartial = true;
        break;
      case 'export-no-sections':
        trace.sawNoSections = true;
        break;
      case 'export-crashed':
        trace.sawExportCrashed = true;
        break;
      default:
        break;
    }
    trace.lines.push(text);
  }
  return trace;
}

const result = (over: Partial<JobResult> = {}): JobResult => ({
  code: 0,
  aborted: false,
  timedOut: false,
  ...over,
});

/** 0.4.0's `reportSummary`, transcribed from its logger calls. */
const STALE_AUTH = [
  '[2026-10-04 19:08:36+00:00] [ERROR] Nothing was exported: the section list for this notebook was never found.',
  '[2026-10-04 19:08:36+00:00] [WARN]   This is what an expired or refused sign-in looks like, and what a',
  '[2026-10-04 19:08:36+00:00] [WARN]   OneNote error page served instead of the notebook looks like.',
  '[2026-10-04 19:08:36+00:00] [WARN]   No notes or assets were written, so an existing export is untouched.',
  '[2026-10-04 19:08:36+00:00] [WARN]   Re-authenticate and re-run. Use --dodump if it repeats: the page',
  '[2026-10-04 19:08:36+00:00] [WARN]   that came up is written to logs/dumps.',
  '[2026-10-04 19:08:37+00:00] [INFO] Total Pages: 0',
  '[2026-10-04 19:08:37+00:00] [INFO] Total Assets: 0',
  '[2026-10-04 19:08:37+00:00] [INFO] Files saved in: /data/x/out/The Complete Notebook',
];

describe('the no-section-list signal', () => {
  it('recognises the one line that decides it', () => {
    expect(
      classify('Nothing was exported: the section list for this notebook was never found.'),
    ).toEqual({ kind: 'export-no-sections' });
  });

  it('is not fooled by the warnings around it', () => {
    for (const line of [
      '  This is what an expired or refused sign-in looks like, and what a',
      '  No notes or assets were written, so an existing export is untouched.',
      '  Re-authenticate and re-run. Use --dodump if it repeats: the page',
    ]) {
      expect(classify(line).kind, line).toBe('none');
    }
  });

  it('needs the whole sentence, so a mention of it in prose is not a signal', () => {
    expect(classify('Nothing was exported: the section list').kind).toBe('none');
    expect(classify('nothing was exported: the section list for this notebook was never found.').kind).toBe(
      'none',
    );
  });

  it('reads the same line off either stream, since ERROR goes to stderr', () => {
    const parsed = parseLine(STALE_AUTH[0]!);
    expect(parsed.level).toBe('error');
    expect(classify(parsed.text)).toEqual({ kind: 'export-no-sections' });
  });
});

describe('an export that reached OneNote and found no notebook', () => {
  /**
   * Before 0.4.0 this run printed `Export complete!` with `Total Pages: 0` and
   * exited 0. The app believed it and told the user the export had worked.
   */
  it('reports the session as expired, not as a generic failure', () => {
    const outcome = judgeExport(traceOf(STALE_AUTH), result({ code: 3 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('auth_expired');
    // The message is the actionable part: it says what to do next.
    expect(outcome.message).toMatch(/sign in again/i);
  });

  it('offers no download, because nothing was written', () => {
    const outcome = judgeExport(traceOf(STALE_AUTH), result({ code: 3 }));
    expect(outcome.partial).toBe(false);
  });

  it('wins over the exit code, which on its own only says "incomplete"', () => {
    // Exit 3 is also what a partial run gives. The line is what distinguishes
    // them, so the line has to be consulted before the code.
    const withSectionsFailing = [
      ...STALE_AUTH,
      '[2026-10-04 19:08:37+00:00] [WARN] Export finished with errors - 1 item(s) could not be exported.',
    ];
    const outcome = judgeExport(traceOf(withSectionsFailing), result({ code: 3 }));
    expect(outcome.error).toBe('auth_expired');
  });

  it('is unaffected by an interrupt, which is a different failure', () => {
    const outcome = judgeExport(traceOf(STALE_AUTH), result({ code: 3, aborted: true }));
    expect(outcome.error).toBe('aborted');
    expect(outcome.partial).toBe(true);
  });
});

describe('an export that wrote nothing', () => {
  /**
   * Real 0.4.0 output when a Microsoft modal covered the section list: all three
   * sections failed to open, the summary said "finished with errors", and
   * `Total Pages: 0` with nothing on disk.
   */
  const BLOCKED = [
    '[2026-10-04 19:02:31+00:00] [WARN] No sections or groups found at the top level. The notebook may be empty, or the OneNote DOM may have changed.',
    '[2026-10-04 19:04:02+00:00] [ERROR] Failed to select section Section w Medias:',
    '[2026-10-04 19:08:37+00:00] [WARN] Export finished with errors - 3 item(s) could not be exported.',
    '[2026-10-04 19:08:37+00:00] [WARN]   Sections failed: 3',
    '[2026-10-04 19:08:37+00:00] [WARN]   See the errors above and logs/app.log for details.',
    '[2026-10-04 19:08:37+00:00] [INFO] Total Pages: 0',
    '[2026-10-04 19:08:37+00:00] [INFO] Total Assets: 0',
    '[2026-10-04 19:08:37+00:00] [INFO] Files saved in: /data/x/out/The Complete Notebook',
  ];

  it('is a failed export, not a partial one', () => {
    const outcome = judgeExport(traceOf(BLOCKED), result({ code: 3 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('export_failed');
    expect(outcome.partial).toBe(false);
  });

  it('would otherwise have offered a zip containing no files', () => {
    // The claim being removed, spelled out: `partial: true` is what puts the
    // download button on the page.
    expect(judgeExport(traceOf(BLOCKED), result({ code: 3 })).partial).toBe(false);
    expect(judgeExport(traceOf(BLOCKED), result({ code: 3 })).error).not.toBe('export_partial');
  });

  it('still calls it partial when some pages did land', () => {
    const partialWithPages = [
      '[2026-10-04 19:02:31+00:00] [INFO] Exporting: Meeting notes ...',
      '[2026-10-04 19:02:33+00:00] [SUCCESS] Saved (1 assets)',
      '[2026-10-04 19:02:34+00:00] [INFO] Exporting: Budget 2026 ...',
      '[2026-10-04 19:02:36+00:00] [INFO] Exporting: Travel plans ...',
      '[2026-10-04 19:08:37+00:00] [WARN] Export finished with errors - 2 item(s) could not be exported.',
      '[2026-10-04 19:08:37+00:00] [WARN]   Pages    failed: 2',
      '[2026-10-04 19:08:37+00:00] [INFO] Total Pages: 3',
    ];
    const outcome = judgeExport(traceOf(partialWithPages), result({ code: 3 }));
    expect(outcome.error).toBe('export_partial');
    expect(outcome.partial).toBe(true);
  });

  it('leaves an empty notebook alone - zero pages is a success there', () => {
    // A notebook with nothing in it exports zero pages and exits 0, printing
    // `Export complete!`. That must not be turned into a failure by the rule
    // above, and the reason it is safe is that this branch is only reached when
    // the package itself said the run finished with errors.
    const emptyNotebook = [
      '[2026-10-04 19:02:31+00:00] [INFO] Scanning sections...',
      '[2026-10-04 19:02:40+00:00] [SUCCESS] Export complete!',
      '[2026-10-04 19:02:40+00:00] [INFO] Total Pages: 0',
      '[2026-10-04 19:02:40+00:00] [INFO] Total Assets: 0',
    ];
    const outcome = judgeExport(traceOf(emptyNotebook), result({ code: 0 }));
    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.partial).toBe(false);
  });

  it('does not rescue a crashed run - a dead tab is its own failure', () => {
    const crashed = [
      '[2026-10-04 19:02:31+00:00] [ERROR] Unexpected internal failure during the export (this is a bug): Target page, context or browser has been closed',
    ];
    expect(judgeExport(traceOf(crashed), result({ code: 1 })).error).toBe('crashed');
  });

  it('still labels an interrupted run partial, because a partial export exists', () => {
    const outcome = judgeExport(traceOf(BLOCKED), result({ code: 3, aborted: true }));
    expect(outcome.error).toBe('aborted');
    expect(outcome.partial).toBe(true);
  });
});
