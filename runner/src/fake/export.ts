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
 *
 * FAKE_EXPORT_PAGES overrides the page count, FAKE_EXPORT_PAGE_MS the delay
 * between pages.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  const mode = process.env.FAKE_EXPORT_MODE ?? 'ok';
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

  const nbDir = join(outputDir, name.replace(/[\\/:*?"<>|]/g, '-'));
  mkdirSync(nbDir, { recursive: true });

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
}

void main();