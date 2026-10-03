import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExportTree, TreeDir } from '@msout-poc/shared';
import { ExportTreePanel } from '../src/web/components/ExportTree';

/**
 * Rendered with `react-dom/server` rather than a DOM.
 *
 * No jsdom, no testing-library: the panel is pure, so rendering it to a string is
 * a real render of the real component - the markup below is what the browser
 * receives. That matters because this component was, for one build, impossible to
 * verify any other way: the accessibility snapshot this session had access to
 * reports text for an element whose children are a single string and drops it
 * when the children are an array, which is exactly how the counts are rendered.
 *
 * The consequence was an hour spent convinced a working panel was broken. A test
 * that asserts the markup does not have that failure mode.
 */

/** The tree the real 24-page export produces, trimmed to what the panel reads. */
function realTree(overrides: Partial<ExportTree> = {}): ExportTree {
  const root: TreeDir = {
    name: 'The Complete Notebook',
    path: 'The Complete Notebook',
    type: 'dir',
    bytes: 2386706,
    fileCount: 28,
    pageCount: 24,
    assetCount: 4,
    children: [
      {
        name: 'Beautiful pages',
        path: 'The Complete Notebook/Beautiful pages',
        type: 'dir',
        bytes: 871,
        fileCount: 6,
        pageCount: 6,
        assetCount: 0,
        children: [
          {
            name: 'Colorized Texts.md',
            path: 'The Complete Notebook/Beautiful pages/Colorized Texts.md',
            type: 'file',
            bytes: 121,
          },
          {
            name: 'Tricky not markdown ).md',
            path: 'The Complete Notebook/Beautiful pages/Tricky not markdown ).md',
            type: 'file',
            bytes: 96,
          },
        ],
      },
      {
        name: 'Section w Medias',
        path: 'The Complete Notebook/Section w Medias',
        type: 'dir',
        bytes: 654,
        fileCount: 7,
        pageCount: 6,
        assetCount: 1,
        children: [
          {
            name: 'assets',
            path: 'The Complete Notebook/Section w Medias/assets',
            type: 'dir',
            bytes: 210,
            fileCount: 1,
            pageCount: 0,
            assetCount: 1,
            children: [
              {
                name: 'bitquery_start1_Use it in Your Application _ Blockchain Data API (V2).pdf',
                path: 'The Complete Notebook/Section w Medias/assets/bitquery_start1_Use it in Your Application _ Blockchain Data API (V2).pdf',
                type: 'file',
                bytes: 210,
              },
            ],
          },
        ],
      },
    ],
  };
  return {
    root,
    truncated: false,
    entries: 42,
    bytes: 2386706,
    pages: 24,
    assets: 4,
    rootPath: 'out/The Complete Notebook',
    ...overrides,
  };
}

const render = (tree: ExportTree): string => renderToStaticMarkup(<ExportTreePanel tree={tree} />);

describe('the export tree panel', () => {
  it('leads with the counts a person is looking for', () => {
    const html = render(realTree());
    expect(html).toContain('24 pages');
    expect(html).toContain('4 attachments');
    // Bytes as something readable, not 2386706.
    expect(html).toContain('2.3 MB');
    expect(html).not.toContain('2386706');
  });

  it('shows the notebook and its sections', () => {
    const html = render(realTree());
    expect(html).toContain('The Complete Notebook');
    expect(html).toContain('Beautiful pages');
    expect(html).toContain('Section w Medias');
  });

  /**
   * Only the root starts open.
   *
   * The alternative - opening every section too - looks friendlier on a notebook
   * with four sections and is unusable on one with four hundred, where it renders
   * thousands of page names on open. One level is the only default that is right
   * for both, and it is asserted here because it is the component's only piece of
   * state and the easiest thing to change by accident.
   */
  it('opens the root and leaves every folder below it closed', () => {
    const html = render(realTree());
    const open = html.match(/aria-expanded="true"/g) ?? [];
    const closed = html.match(/aria-expanded="false"/g) ?? [];
    expect(open).toHaveLength(1);
    // `Beautiful pages` and `Section w Medias`. Their own contents, including the
    // `assets` folder, are not rendered until they are opened - which is the point
    // of not expanding them.
    expect(closed).toHaveLength(2);
    expect(html).not.toContain('Colorized Texts.md');
    expect(html).not.toContain('aria-expanded="false"></button><ul');
  });

  it('does not render a closed folder\'s contents at all', () => {
    // Not hidden with CSS - absent. A four-thousand-page vault would otherwise put
    // every filename in the document whether or not the user asked for it.
    const html = render(realTree());
    expect(html).not.toContain('bitquery_start1');
    expect(html).not.toContain('Colorized Texts.md');
  });

  it('uses singulars for a one-page or one-attachment folder', () => {
    const one: ExportTree = {
      ...realTree(),
      root: {
        name: 'Solo',
        path: 'Solo',
        type: 'dir',
        bytes: 10,
        fileCount: 2,
        pageCount: 1,
        assetCount: 1,
        children: [],
      },
      pages: 1,
      assets: 1,
    };
    const html = render(one);
    expect(html).toContain('1 page,');
    expect(html).toContain('1 attachment,');
    expect(html).not.toContain('1 pages');
  });

  it('calls an empty folder empty rather than showing a bare name', () => {
    const empty: ExportTree = {
      ...realTree(),
      root: {
        name: 'Nothing here',
        path: 'Nothing here',
        type: 'dir',
        bytes: 0,
        fileCount: 0,
        pageCount: 0,
        assetCount: 0,
        children: [],
      },
    };
    expect(render(empty)).toContain('empty');
  });

  it('says so when the walk was cut short, rather than implying completeness', () => {
    // A truncated tree presented as the whole export is worse than no tree: the
    // user would conclude a page is missing when the listing is what was cut.
    const html = render(realTree({ truncated: true, entries: 4000 }));
    expect(html).toContain('showing the first 4000 items');
    expect(html).toContain('download the zip for the rest');
  });

  it('does not mention truncation when the tree is complete', () => {
    expect(render(realTree())).not.toContain('download the zip for the rest');
  });

  it('escapes names rather than rendering them as markup', () => {
    // Page titles come from OneNote. A title is attacker-influenced text and
    // must never become markup in someone else's browser.
    const nasty: ExportTree = {
      ...realTree(),
      root: {
        name: '<script>alert(1)</script>',
        path: '<script>alert(1)</script>',
        type: 'dir',
        bytes: 0,
        fileCount: 0,
        pageCount: 0,
        assetCount: 0,
        children: [],
      },
    };
    const html = render(nasty);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders small byte counts exactly', () => {
    const tiny: ExportTree = {
      ...realTree(),
      bytes: 512,
      root: { ...(realTree().root as TreeDir), bytes: 512 },
    };
    expect(render(tiny)).toContain('512 B');
  });

  it('falls back to a sentence when there is no tree at all', () => {
    const html = render(realTree({ root: null }));
    expect(html).toContain('Nothing on disk yet');
    expect(html).not.toContain('tree-list');
  });
});