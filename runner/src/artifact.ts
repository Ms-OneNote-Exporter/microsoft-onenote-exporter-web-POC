import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import archiver from 'archiver';

/**
 * Streaming zip of an exported notebook.
 *
 * Streamed rather than written to a temp file first: a large notebook is
 * gigabytes, and making a second full copy of it is how a host runs out of disk
 * during the one operation most likely to fill it.
 *
 * @returns null when there is nothing to zip, so the route can answer 404 rather
 * than producing an empty archive that looks like a successful export.
 */
export function zipDir(dir: string): archiver.Archiver | null {
  if (!existsSync(dir)) return null;

  // `--output-dir /data/<guid>/out` and the package creates `<Notebook>/…` inside
  // it. A session can export more than once, so every top-level directory under
  // out/ is zipped as a root entry; a stray loose file is included too.
  const entries = readdirSync(dir);
  if (entries.length === 0) return null;

  const archive = archiver('zip', { zlib: { level: 6 } });

  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      archive.directory(full, entry);
    } else {
      archive.file(full, { name: entry });
    }
  }

  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') return; // a file vanished mid-zip; not fatal
    throw err;
  });
  // Without a listener an archive error is an unhandled 'error' event and takes
  // the sidecar down mid-download.
  archive.on('error', () => archive.abort());

  archive.finalize();
  return archive;
}

/**
 * A filename safe to put in `Content-Disposition`, from a notebook name that
 * came from OneNote and can contain slashes, quotes, newlines and emoji.
 */
/** Matches ASCII control characters, including the newline and carriage return. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/**
 * A filename safe to put in `Content-Disposition`, from a notebook name that came
 * from OneNote and can contain slashes, quotes, newlines and emoji.
 *
 * Characters that could break out of the quoted header value or the filesystem
 * are removed rather than escaped: a mangled filename is a far smaller problem
 * than a header injection.
 */
export function safeZipName(notebook: string, partial: boolean, at: Date): string {
  const cleaned = (notebook || '')
    .replace(CONTROL_RE, '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const stem = cleaned.length > 0 ? cleaned : 'notebook';
  // `2026-10-02T20:00:00.000Z` -> `20261002T200000Z`: second precision is
  // enough to tell two downloads apart, and the milliseconds would only make the
  // name longer. The T is kept because a run of digits is not a readable date.
  const stamp = `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const suffix = partial ? '-partial' : '';
  return `${stem}${suffix}-${stamp}.zip`;
}

/** Total bytes under `dir`, for the artifact size shown before download. */
export function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/** Path of the notebook subdirectory the export created, if any. */
export function firstSubdir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) return join(dir, entry.name);
  }
  return null;
}

/** Exposed for tests: is this path inside `root`? Guards the archive globbing. */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`${sep}..`);
}