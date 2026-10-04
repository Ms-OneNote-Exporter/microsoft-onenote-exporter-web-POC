/**
 * Fake `onenote-export-nb`.
 *
 * Reproduces the real package's line-by-line output in its own timestamp format
 * (`[2026-10-02 20:39:18+02:00] [INFO] ...`, which differs from the other two
 * packages) and writes real markdown + an asset into `--output-dir`, so the zip
 * path has something to archive.
 *
 * Behaviour switches, so the app's outcomes can all be exercised:
 *
 *   FAKE_EXPORT_MODE=ok        default: full run, "Export complete!"
 *   FAKE_EXPORT_MODE=partial   "Export finished with errors - N item(s)"
 *   FAKE_EXPORT_MODE=stopped   "Export stopped early - ..."
 *   FAKE_EXPORT_MODE=crash     the unhandled-rejection path, exit 1
 *   FAKE_EXPORT_MODE=slow      long run, for interrupting and for job timeouts
 *   FAKE_EXPORT_MODE=nolink    no target given: the --non-interactive fail-fast
 *   FAKE_EXPORT_MODE=staleauth 0.4.0's expired-or-refused-sign-in path: no
 *                              section list found, nothing written, exit 3
 *   FAKE_EXPORT_MODE=blocked   0.4.0 run where every section failed to open:
 *                              "finished with errors", zero pages written, exit 3
 *
 * FAKE_EXPORT_PAGES overrides the page count, FAKE_EXPORT_PAGE_MS the delay
 * between pages.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeLogger, parseArgs, sleep } from './logger';

const log = makeLogger('isoWithOffset');

const PAGES = [
  'Meeting notes',
  'Budget 2026',
  'Travel plans',
  'Reading list',
  'Ideas',
  'Recipes',
  'Weekly review',
  'Book notes',
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const authFile = args['auth-file'];
  const notebook = args.notebook;
  const notebookLink = args['notebook-link'];
  const outputDir = args['output-dir'] ?? './output';
  let mode = process.env.FAKE_EXPORT_MODE ?? 'ok';
  // `fake-export-mode` beside the auth file, the same override `check` takes.
  // FAKE_EXPORT_MODE alone is global to the runner, so a test that needs one
  // session to fail could not leave another session succeeding. A file in the
  // session directory is the smallest way to make one session's outcome differ
  // from another's - which is exactly what the two 0.4.0 outcomes need, since
  // they are both *failures* and would otherwise have to be run one at a time.
  const override = join(dirname(authFile ?? '.'), 'fake-export-mode');
  if (authFile && existsSync(override)) {
    mode = readFileSync(override, 'utf8').trim() || mode;
  }
  const total = Number.parseInt(process.env.FAKE_EXPORT_PAGES ?? '8', 10);
  const perPageMs = Number.parseInt(process.env.FAKE_EXPORT_PAGE_MS ?? '250', 10);

  if (args['non-interactive'] && !notebook && !notebookLink) {
    // Real wording, captured from the published package.
    log('ERROR', '--non-interactive requires either --notebook <name> or --notebook-link <url>.');
    log('ERROR', 'Without one of them the export would stop at the interactive notebook picker.');
    process.exit(2);
    return;
  }

  log('INFO', 'Fetching notebooks...');
  log('INFO', 'Connecting to OneNote...');
  await sleep(200);

  if (mode === 'nolink') {
    // The real package's message when --notebook does not match anything.
    log('INFO', 'Auto-selecting notebook: "Nope"...');
    await sleep(200);
    log('ERROR', 'Export failed:', new Error('Notebook "Nope" not found in list. Available: Personal, Work, Recipes & "stuff"'));
    process.exit(1);
    return;
  }

  if (!authFile || !existsSync(authFile)) {
    log('ERROR', 'Export failed:', new Error(`Authentication file not found: ${authFile}`));
    process.exit(1);
    return;
  }

  if (notebook) {
    log('INFO', `Auto-selecting notebook: "${notebook}"...`);
  }
  const name = notebook ?? 'Personal';
  log('INFO', `Exporting notebook: ${name}`);

  if (mode === 'crash') {
    await sleep(300);
    // The real package's handler for a Playwright target that dies mid-run.
    log('ERROR', 'Unexpected internal failure during the export (this is a bug):', new Error('Target page, context or browser has been closed'));
    process.exit(1);
    return;
  }

  if (mode === 'staleauth') {
    // 0.4.0's summary for a run that never found a section list, which it says
    // is what an expired or refused sign-in looks like. Before 0.4.0 this case
    // printed `Export complete!` with `Total Pages: 0` and exited 0.
    //
    // The folder is still created and left behind, exactly as the real package
    // does: an empty notebook folder named after whatever the page's <title>
    // was. Removing it would mean deleting a directory after a failed run.
    const staleDir = join(outputDir, name.replace(/[\\/:*?"<>|]/g, '-'));
    mkdirSync(staleDir, { recursive: true });
    await sleep(300);
    log('ERROR', 'Nothing was exported: the section list for this notebook was never found.');
    log('WARN', '  This is what an expired or refused sign-in looks like, and what a');
    log('WARN', '  OneNote error page served instead of the notebook looks like.');
    log('WARN', '  No notes or assets were written, so an existing export is untouched.');
    log('WARN', '  Re-authenticate and re-run. Use --dodump if it repeats: the page');
    log('WARN', '  that came up is written to logs/dumps.');
    log('INFO', 'Total Pages: 0');
    log('INFO', 'Total Assets: 0');
    log('INFO', `Files saved in: ${staleDir}`);
    // `exitCodeForStats` counts notebookNotFound as missing since 0.4.0.
    process.exitCode = 3;
    return;
  }

  const nbDir = join(outputDir, name.replace(/[\\/:*?"<>|]/g, '-'));
  mkdirSync(nbDir, { recursive: true });

  if (mode === 'blocked') {
    // Real 0.4.0 output when a Microsoft modal covered the section list and every
    // section failed to open: the summary says "finished with errors" and
    // `Total Pages: 0`, and nothing at all reached the disk. The honest reading is
    // a failed export, not a partial one.
    log('WARN', 'Export finished with errors - 3 item(s) could not be exported.');
    log('WARN', '  Sections failed: 3');
    log('WARN', '  See the errors above and logs/app.log for details.');
    log('INFO', 'Total Pages: 0');
    log('INFO', 'Total Assets: 0');
    log('INFO', `Files saved in: ${nbDir}`);
    process.exitCode = 3;
    return;
  }

  log('STEP', '[Section] Notes');
  log('INFO', `Found ${total} pages. Starting extraction...`);

  let assets = 0;
  for (let i = 0; i < total; i += 1) {
    const page = PAGES[i % PAGES.length] ?? `Page ${i + 1}`;
    log('INFO', `Exporting: ${page} ...`);
    await sleep(perPageMs);

    writeFileSync(
      join(nbDir, `${page}.md`),
      `# ${page}\n\nExported by the fake exporter.\n\n- item one\n- item two\n`,
    );
    const savedAssets = i % 2 === 0 ? 1 : 0;
    if (savedAssets === 1) {
      assets += 1;
      const assetDir = join(nbDir, 'assets');
      mkdirSync(assetDir, { recursive: true });
      writeFileSync(join(assetDir, `image-${assets}.txt`), `fake asset ${assets}\n`);
    }
    // The line that means the file exists. The real package prints this after
    // writing the page, and `Exporting:` before starting it; a fake that emits
    // only the latter cannot express a page that failed, which is the case the
    // page counter exists to get right.
    log('SUCCESS', `Saved (${savedAssets} asset${savedAssets === 1 ? '' : 's'})`);

    // A page can fail to export and the run continues, which is exactly why the
    // real package prints a summary of failures rather than a bare "complete".
    if (mode === 'stopped' && i === 2) {
      log('WARN', 'Export stopped early - the OneNote editor tab went away.');
      log('WARN', '  The totals below are what was written; the rest of the notebook was not exported.');
      log('INFO', `Total Pages: ${i + 1}`);
      log('INFO', `Total Assets: ${assets}`);
      log('INFO', `Files saved in: ${nbDir}`);
      return; // exit 0: a partial run is not a failed run
    }
  }

  if (mode === 'partial') {
    log('WARN', 'Export finished with errors - 1 item(s) could not be exported.');
    log('WARN', '  Pages    failed: 1');
    log('WARN', '  See the errors above and logs/app.log for details.');
  } else if (mode !== 'stopped') {
    log('SUCCESS', 'Export complete!');
  }

  log('INFO', `Total Pages: ${total}`);
  log('INFO', `Total Assets: ${assets}`);
  log('INFO', 'Internal links: 3 resolved, 0 unresolved');
  log('INFO', `Files saved in: ${nbDir}`);

  // `exitCodeForStats`: 3 when items are missing from the vault, 0 when not.
  // A partial run has pages missing, so it exits 3 - which is the whole reason
  // the package distinguishes 3 from 1. A supervisor must not retry this one.
  //
  // Note the contrast with `stopped` above, which exits 0: nothing failed there,
  // the run was cut short, so there is nothing to retry and nothing missing from
  // a *completed* attempt.
  if (mode === 'partial') process.exitCode = 3;
}

void main();