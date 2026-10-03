import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSessionState, sessionPaths, type SessionState } from '@msout-poc/shared';
import { buildExportTree, treeRootFor, type TreeDir } from '../src/server/export-tree';

const GUID = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'msout-tree-'));
}

/**
 * The session's output directory, via the one function that knows the layout.
 *
 * Building the path by hand in the test meant writing to `<root>/out` while the
 * code looked in `<root>/<guid>/out`, which failed every test for a reason that
 * had nothing to do with the walker.
 */
function outDir(root: string): string {
  return sessionPaths(root, GUID).outDir;
}

/** A state whose export claims it wrote to `outPath`. */
function stateWith(outPath: string | null): SessionState {
  const state = newSessionState(GUID, new Date('2026-10-03T12:00:00Z'), 12);
  state.export.state = 'done';
  state.export.outPath = outPath;
  state.export.pagesExported = 24;
  return state;
}

/** Writes a file, creating parents. */
function write(root: string, relative: string, contents = 'x'): void {
  const full = join(root, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
}

describe('buildExportTree', () => {
  /**
   * The shape below is copied from a real export of a 24-page notebook, with the
   * names it actually used - the spaces, the brackets, the `_1` collision suffix
   * and the four-level nesting are all things a real vault does and a tidy test
   * fixture never does.
   */
  function realShapedExport(): string {
    const root = makeRoot();
    const nb = join(outDir(root), 'The Complete Notebook');
    write(nb, 'Beautiful pages/Colorized Texts.md');
    write(nb, 'Beautiful pages/Tricky not markdown ).md');
    write(
      nb,
      'New Section Group/subSct4 - The Tree/1st Tree in Tree/anotherSection Group/Notebook in anotherSectionGrp/Note deep down.md',
    );
    write(nb, 'sct w duppages/Duplicate Title.md');
    write(nb, 'sct w duppages/Duplicate Title_1.md');
    write(nb, 'Section w Medias/attachment_PDF.md');
    write(nb, 'Section w Medias/assets/attached_file.bin', 'aaaa');
    write(nb, 'Section w Medias/assets/attached_file_1.bin', 'bb');
    write(nb, 'Section w Medias/assets/attachment_pic-GIF_img_1.png', 'cccccc');
    // A real attachment name from the same export: spaces, underscores, a dot
    // inside the stem and a parenthesised version suffix.
    write(
      nb,
      'Section w Medias/assets/bitquery_start1_Use it in Your Application _ Blockchain Data API (V2).pdf',
      'd',
    );
    return root;
  }

  it('finds every page and attachment in a real-shaped export', async () => {
    const root = realShapedExport();
    try {
      const tree = await buildExportTree(stateWith('The Complete Notebook'), root);
      expect(tree.pages).toBe(6);
      expect(tree.assets).toBe(4);
      expect(tree.truncated).toBe(false);

      const top = tree.root as TreeDir;
      expect(top.name).toBe('The Complete Notebook');
      expect(top.children?.map((c) => c.name)).toEqual([
        // Directories first, then files - the order `tree` prints, and the order
        // a reader expects: the sections, then the loose pages.
        'Beautiful pages',
        'New Section Group',
        'sct w duppages',
        'Section w Medias',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the names OneNote produced, verbatim', async () => {
    const root = realShapedExport();
    try {
      const tree = await buildExportTree(stateWith('The Complete Notebook'), root);
      const names: string[] = [];
      const collect = (node: TreeDir | { children?: unknown[] }): void => {
        for (const child of (node.children ?? []) as TreeDir[]) {
          names.push(child.name);
          if (child.type === 'dir') collect(child);
        }
      };
      collect(tree.root as TreeDir);

      // Every one of these would be mangled by a walker that normalised names.
      expect(names).toContain('Tricky not markdown ).md');
      expect(names).toContain('Duplicate Title_1.md');
      expect(names).toContain('attached_file_1.bin');
      expect(names).toContain('bitquery_start1_Use it in Your Application _ Blockchain Data API (V2).pdf');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('walks nesting as deep as a notebook actually goes', async () => {
    const root = realShapedExport();
    try {
      const tree = await buildExportTree(stateWith('The Complete Notebook'), root);
      const deep = 'New Section Group/subSct4 - The Tree/1st Tree in Tree/anotherSection Group/Notebook in anotherSectionGrp/Note deep down.md';
      // The page is five levels below the notebook folder and is still reached.
      expect(tree.pages).toBe(6);
      let node = tree.root as TreeDir;
      for (const segment of deep.split('/').slice(0, -1)) {
        const next = node.children.find((c) => c.name === segment);
        expect(next, `expected to descend into ${segment}`).toBeDefined();
        node = next as TreeDir;
      }
      expect(node.children.some((c) => c.name === 'Note deep down.md')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds up the bytes', async () => {
    const root = makeRoot();
    try {
      write(join(outDir(root), 'NB'), 'a.md', 'x'.repeat(10));
      write(join(outDir(root), 'NB', 'assets'), 'b.png', 'y'.repeat(5));
      const tree = await buildExportTree(stateWith('NB'), root);
      expect(tree.bytes).toBe(15);
      expect((tree.root as TreeDir).bytes).toBe(15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an empty result rather than failing when nothing was written', async () => {
    const root = makeRoot();
    try {
      mkdirSync(outDir(root), { recursive: true });
      const tree = await buildExportTree(stateWith('Notebook'), root);
      expect(tree.root).toBeNull();
      expect(tree.pages).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the output root when the notebook folder name cannot be derived', async () => {
    // The state has no reported path, which is what a session looks like when the
    // `Files saved in:` line was missing. The root is shown rather than nothing:
    // one folder too many beats an empty panel.
    const root = makeRoot();
    try {
      write(join(outDir(root), 'Whatever'), 'page.md');
      const tree = await buildExportTree(stateWith(null), root);
      expect(tree.root).not.toBeNull();
      expect(tree.pages).toBe(1);
      expect(tree.root?.name).toBe('out');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('containment', () => {
    it('refuses a reported path that points outside the session', async () => {
      // A state.json written before outPath was validated can hold anything.
      const root = makeRoot();
      try {
        write(join(outDir(root), '..', '..', 'elsewhere'), 'secret.md');
        const chosen = treeRootFor(stateWith('../../elsewhere'), root);
        // Falls back inside the session rather than honouring the escape.
        expect(chosen).toBe(outDir(root));
        const tree = await buildExportTree(stateWith('../../elsewhere'), root);
        expect(tree.pages).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('cannot be walked out of the session by an absolute path in outPath', async () => {
      const root = makeRoot();
      try {
        write(join(root, 'etc'), 'secret.md');
        write(join(outDir(root), 'etc'), 'inside.md');
        const chosen = treeRootFor(stateWith('/etc'), root);
        // `/etc` is joined *onto* the output root rather than replacing it, so
        // the worst case is a folder that does not exist inside the session.
        expect(chosen).toBe(join(outDir(root), 'etc'));
        expect(chosen.startsWith(outDir(root))).toBe(true);
        const tree = await buildExportTree(stateWith('/etc'), root);
        expect(JSON.stringify(tree)).not.toContain('secret.md');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('never follows a symlink out of the tree', async () => {
      // Page titles come from OneNote, so a name is attacker-influenced text.
      // A walker that resolved links would be a way out of the session directory.
      const root = makeRoot();
      try {
        write(root, 'outside/secret.md', 'classified');
        write(join(outDir(root), 'NB'), 'page.md');
        symlinkSync(join(root, 'outside'), join(outDir(root), 'NB', 'escape'));
        const tree = await buildExportTree(stateWith('NB'), root);
        expect(tree.pages).toBe(1);
        expect(JSON.stringify(tree)).not.toContain('secret.md');
        expect(tree.truncated).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('emits paths that cannot escape the session, whatever the names', async () => {
      const root = makeRoot();
      try {
        write(join(outDir(root), 'NB'), 'escape.md');
        write(join(outDir(root), 'NB', 'a..b'), 'c.md');
        const tree = await buildExportTree(stateWith('NB'), root);
        for (const path of collectPaths(tree.root as TreeDir)) {
          expect(path.startsWith('/')).toBe(false);
          expect(path.split('/')).not.toContain('..');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('limits', () => {
    it('cuts off a very large tree and says so', async () => {
      const root = makeRoot();
      try {
        for (let i = 0; i < 30; i += 1) write(join(outDir(root), 'NB'), `page-${i}.md`);
        // A budget of 5 rather than the real 4000, so the bound is exercised
        // without writing four thousand files into a temp directory.
        const tree = await buildExportTree(stateWith('NB'), root, {
          maxDepth: 12,
          maxEntries: 5,
        });
        expect(tree.pages).toBeLessThan(30);
        // The counts are then a floor, and the UI has to say so rather than
        // presenting a truncated tree as the whole export.
        expect(tree.truncated).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('stops descending past the depth limit', async () => {
      const root = makeRoot();
      try {
        write(join(outDir(root), 'NB', 'a', 'b', 'c', 'd'), 'deep.md');
        write(join(outDir(root), 'NB'), 'shallow.md');
        const tree = await buildExportTree(stateWith('NB'), root, { maxDepth: 2, maxEntries: 4000 });
        expect(tree.pages).toBe(1);
        expect(tree.truncated).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('leaves an enormous but shallow tree intact at the default limit', async () => {
      // The other direction: a plain 60-page notebook must not be truncated just
      // because the guard exists.
      const root = makeRoot();
      try {
        for (let i = 0; i < 60; i += 1) write(join(outDir(root), 'NB'), `page-${i}.md`);
        const tree = await buildExportTree(stateWith('NB'), root);
        expect(tree.pages).toBe(60);
        expect(tree.truncated).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

function collectPaths(node: TreeDir | { children?: unknown[] }): string[] {
  const out: string[] = [node.path];
  for (const child of (node.children ?? []) as TreeDir[]) {
    out.push(...collectPaths(child));
  }
  return out;
}