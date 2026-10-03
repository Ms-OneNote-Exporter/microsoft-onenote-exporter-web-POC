import { useEffect, useState } from 'react';
import type { ExportTree, TreeDir, TreeNode } from '@msout-poc/shared';

/**
 * Block 4: what the export actually produced.
 *
 * The zip answers "give me the files". This answers the question a person asks
 * after a long export: did my sections come through, are the attachments there,
 * and is the thing that is missing the one page the exporter said it could not
 * write. A page count cannot answer any of that, and a 24-page count that is
 * really 26 attempts is worse than nothing.
 *
 * Children are fetched when a folder is opened rather than all at once. The tree
 * for a large vault is thousands of lines, and rendering them closed would make
 * the page slower to open than the download it sits next to.
 */

async function fetchTree(guid: string): Promise<ExportTree> {
  const response = await fetch(`/api/session/tree?guid=${encodeURIComponent(guid)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`could not read the output (${response.status})`);
  return (await response.json()) as ExportTree;
}

/** Bytes as something a person can read. */
function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What a folder's line says after its name. */
function summarise(node: TreeDir): string {
  const parts: string[] = [];
  if (node.pageCount > 0) parts.push(`${node.pageCount} page${node.pageCount === 1 ? '' : 's'}`);
  if (node.assetCount > 0) parts.push(`${node.assetCount} attachment${node.assetCount === 1 ? '' : 's'}`);
  if (parts.length === 0 && node.fileCount === 0) parts.push('empty');
  return parts.join(', ');
}

/**
 * The rendering, with no fetching in it.
 *
 * Split out so it can be rendered and asserted without a browser or a DOM: the
 * fetching half only runs inside an effect, and effects do not run when React
 * renders to a string, so testing this component any other way means testing
 * nothing. The split is also just better shape - one part decides *what* to
 * show, the other decides *when* it is known.
 */
export function ExportTreePanel({ tree }: { tree: ExportTree }) {
  // `root` is non-null by the time this is rendered - the shell returns early
  // otherwise - so the assertion is stated once, here, rather than at every use.
  if (!tree.root) return <p className="lead">Nothing on disk yet.</p>;
  return (
    <div className="tree">
      <p className="tree-summary">
        {tree.pages} page{tree.pages === 1 ? '' : 's'}, {tree.assets} attachment
        {tree.assets === 1 ? '' : 's'}, {human(tree.bytes)}
        {tree.truncated && (
          <>
            {' '}
            <strong>
              (showing the first {tree.entries} items — download the zip for the rest)
            </strong>
          </>
        )}
      </p>
      <ul className="tree-list">
        <TreeRow node={tree.root} depth={0} />
      </ul>
    </div>
  );
}

/** Fetches the tree once per mount. Keyed by the caller; see ExportBlock. */
export function ExportTree({ guid }: { guid: string }) {
  const [tree, setTree] = useState<ExportTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * One fetch per mount, keyed by the caller.
   *
   * The caller passes a React `key` of the job id, so a second export remounts
   * this component and refetches. That replaced a `reloadKey` prop in the
   * dependency list, which looked equivalent and was not: the effect could be
   * torn down and restarted by a dep that changed identity without the job
   * changing, and the `cancelled` flag then discarded a fetch that had already
   * come back - leaving the panel reading "Reading the output…" forever, with
   * the server having answered in milliseconds.
   *
   * `ignore` rather than `cancelled`, and no useCallback: the cleanup of an
   * effect is a statement about this effect run, not a closure to be shared.
   */
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError(null);
    fetchTree(guid)
      .then((next) => {
        if (!ignore) setTree(next);
      })
      .catch((caught: Error) => {
        if (!ignore) setError(caught.message);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [guid]);

  if (loading && !tree) return <p className="lead">Reading the output…</p>;
  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!tree || !tree.root) {
    return <p className="lead">Nothing on disk yet. The tree appears once an export finishes.</p>;
  }

  return <ExportTreePanel tree={tree} />;
}

/** One node. A folder is a button; a file is a line. */
function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const indent = { paddingLeft: `${depth * 1.1}rem` };

  if (node.type === 'file') {
    return (
      <li className="tree-file" style={indent}>
        <span className="tree-icon" aria-hidden="true">
          {node.name.toLowerCase().endsWith('.md') ? '▤' : '▪'}
        </span>
        <span className="tree-name">{node.name}</span>
        <span className="tree-size">{human(node.bytes)}</span>
      </li>
    );
  }

  const empty = node.children.length === 0;
  return (
    <li className="tree-dir">
      <button
        type="button"
        className="tree-toggle"
        style={indent}
        // `aria-expanded` is what makes this readable as a control rather than as
        // decoration that happens to be clickable.
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="tree-caret" aria-hidden="true">
          {empty ? '·' : open ? '▾' : '▸'}
        </span>
        <span className="tree-name">{node.name}</span>
        <span className="tree-meta">{summarise(node)}</span>
      </button>
      {open && !empty && (
        <ul className="tree-list">
          {node.children.map((child) => (
            // The path is unique within the tree because it is the real relative
            // path, and it cannot contain `..` — the server refuses to emit one.
            <TreeRow key={child.path} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}