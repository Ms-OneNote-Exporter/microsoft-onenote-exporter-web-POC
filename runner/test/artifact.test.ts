import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dirSize, firstSubdir, isInside, safeZipName, zipDir } from '../src/artifact';

/** Collects an archiver stream into a Buffer. */
function zipToBuffer(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = zipDir(dir);
    if (!archive) {
      reject(new Error('zipDir returned null'));
      return;
    }
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
}

describe('safeZipName', () => {
  it('keeps a normal notebook name readable', () => {
    expect(safeZipName('Personal', false, new Date('2026-10-02T20:00:00Z'))).toBe(
      'Personal-20261002T200000Z.zip',
    );
  });

  it('marks a partial export in the filename, not only in the UI', () => {
    expect(safeZipName('Work', true, new Date('2026-10-02T20:00:00Z'))).toBe(
      'Work-partial-20261002T200000Z.zip',
    );
  });

  it('strips path separators, so a notebook name cannot escape the filename', () => {
    expect(safeZipName('../../etc/passwd', false, new Date('2026-10-02T20:00:00Z'))).not.toMatch(/[/\\]/);
  });

  it('strips quotes, which would break the Content-Disposition header', () => {
    const name = safeZipName('Re"ci"pes', false, new Date('2026-10-02T20:00:00Z'));
    expect(name).not.toContain('"');
  });

  it('strips control characters and newlines', () => {
    const name = safeZipName('a\nb\rc', false, new Date('2026-10-02T20:00:00Z'));
    expect(name).toBe('abc-20261002T200000Z.zip');
  });

  it('keeps non-ascii, because notebook names are not ascii', () => {
    expect(safeZipName('Café ☕', false, new Date('2026-10-02T20:00:00Z'))).toBe(
      'Café ☕-20261002T200000Z.zip',
    );
  });

  it('falls back to a usable name for empty or hostile input', () => {
    expect(safeZipName('', false, new Date('2026-10-02T20:00:00Z'))).toBe(
      'notebook-20261002T200000Z.zip',
    );
    expect(safeZipName('///', false, new Date('2026-10-02T20:00:00Z'))).not.toBe('');
  });

  it('bounds the length', () => {
    expect(safeZipName('x'.repeat(500), false, new Date('2026-10-02T20:00:00Z')).length).toBeLessThan(120);
  });

  it('collapses whitespace rather than emitting a double space', () => {
    expect(safeZipName('My   Notebook', false, new Date('2026-10-02T20:00:00Z'))).toBe(
      'My Notebook-20261002T200000Z.zip',
    );
  });
});

describe('zipDir', () => {
  const roots: string[] = [];
  function makeTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'msout-zip-'));
    roots.push(root);
    const nb = join(root, 'Personal');
    mkdirSync(join(nb, 'assets'), { recursive: true });
    writeFileSync(join(nb, 'Note.md'), '# Note\n');
    writeFileSync(join(nb, 'assets', 'image.png'), 'not really a png');
    return root;
  }

  it('produces a real zip containing the exported files', async () => {
    const zip = await zipToBuffer(makeTree());
    // Local file header magic and end-of-central-directory magic.
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zip.includes(Buffer.from('Note.md'))).toBe(true);
    expect(zip.includes(Buffer.from('assets/image.png'))).toBe(true);
  });

  it('keeps the notebook name as the top level entry', async () => {
    const zip = await zipToBuffer(makeTree());
    expect(zip.includes(Buffer.from('Personal/'))).toBe(true);
  });

  it('returns null for a missing directory, so the route can 404', () => {
    expect(zipDir('/nonexistent/path/for/test')).toBeNull();
  });

  it('returns null for an empty directory rather than an empty archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'msout-zip-'));
    roots.push(root);
    expect(zipDir(root)).toBeNull();
  });

  it('archives a session that exported more than once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msout-zip-'));
    roots.push(root);
    for (const name of ['First', 'Second']) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, 'a.md'), '# a\n');
    }
    const zip = await zipToBuffer(root);
    expect(zip.includes(Buffer.from('First/a.md'))).toBe(true);
    expect(zip.includes(Buffer.from('Second/a.md'))).toBe(true);
  });

  it('includes a loose file at the top of the output dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msout-zip-'));
    roots.push(root);
    mkdirSync(join(root, 'Nb'), { recursive: true });
    writeFileSync(join(root, 'stray.txt'), 'x');
    expect((await zipToBuffer(root)).includes(Buffer.from('stray.txt'))).toBe(true);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
});

describe('dirSize', () => {
  it('is 0 for a missing directory', () => {
    expect(dirSize('/nonexistent')).toBe(0);
  });

  it('sums nested files', () => {
    const root = mkdtempSync(join(tmpdir(), 'msout-size-'));
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'top.md'), 'x'.repeat(10));
    writeFileSync(join(root, 'a', 'mid.md'), 'x'.repeat(20));
    writeFileSync(join(root, 'a', 'b', 'deep.md'), 'x'.repeat(30));
    expect(dirSize(root)).toBe(60);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('firstSubdir', () => {
  it('finds the notebook directory the export created', () => {
    const root = mkdtempSync(join(tmpdir(), 'msout-sub-'));
    mkdirSync(join(root, 'Work Notebook'), { recursive: true });
    expect(firstSubdir(root)).toBe(join(root, 'Work Notebook'));
    rmSync(root, { recursive: true, force: true });
  });

  it('is null when nothing was exported', () => {
    expect(firstSubdir('/nonexistent')).toBeNull();
  });
});

describe('isInside', () => {
  it('accepts a path under the root', () => {
    expect(isInside('/data/guid', '/data/guid/out')).toBe(true);
  });

  it('rejects a path that escapes the root', () => {
    expect(isInside('/data/guid', '/data/other/out')).toBe(false);
    expect(isInside('/data/guid', '/data/guid/../other')).toBe(false);
  });

  it('rejects the root itself', () => {
    expect(isInside('/data/guid', '/data/guid')).toBe(false);
  });
});