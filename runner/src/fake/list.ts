/**
 * Fake `microsoft-onenote-list-notebooks`.
 *
 * Same timestamp format as the real one (month name), the real two-line preamble
 * and the real `<n>. <name> (<url>)` listing - which is what the app's parser
 * has to scrape, since the package exposes no JSON output.
 *
 * A missing auth file reproduces the real failure exactly: one stdout line, one
 * stderr error, exit 1.
 */
import { existsSync } from 'node:fs';
import { makeLogger, parseArgs, sleep } from './logger';

const log = makeLogger('monthName');

const NOTEBOOKS = [
  { name: 'Personal', url: 'https://onedote.cloud.microsoft/onenote/?id=Personal&wdOrigin=onenote' },
  { name: 'Work', url: 'https://onenote.cloud.microsoft/onenote/?id=Work%20Notebook&wdOrigin=onenote' },
  { name: 'Recipes & "stuff"', url: 'https://onedote.cloud.microsoft/onenote/?id=Recipes' },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const authFile = args['auth-file'];
  if (!authFile) {
    log('ERROR', 'Failed to list notebooks.');
    log('ERROR', 'Error: --auth-file is required');
    process.exitCode = 1;
    return;
  }

  log('INFO', 'Connecting to OneNote...');
  log('DEBUG', 'Launching browser (headless: true)...');
  await sleep(300);

  if (!existsSync(authFile)) {
    // Real output, captured from the published package:
    // "Authentication file not found: <path>"
    log('ERROR', 'Failed to list notebooks.');
    log('ERROR', `Error: Authentication file not found: ${authFile}`);
    process.exitCode = 1;
    return;
  }

  log('INFO', 'Found 3 notebooks.');
  log('STEP', '\nAvailable Notebooks:');
  NOTEBOOKS.forEach((nb, index) => {
    log('INFO', `${index + 1}. ${nb.name} (${nb.url})`);
  });
}

void main();