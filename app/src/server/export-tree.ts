import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  relativeInside,
  sessionPaths,
  type ExportTree,
  type SessionState,
  type TreeDir,
  type TreeFile,
  type TreeNode,
} from '@msout-poc/shared';

// Re-exported so callers that already import the walker get the shapes with it.
export type { ExportTree, TreeDir, TreeFile, TreeNode };

/**
 * The export's output, as a tree the user can browse.
 *
 * The zip answers "give me the files". This answers "what did I actually get",
 * which is a different question and the one a person asks after a long export:
 * did my sections come through, are the attachments there, is the thing that is
 * missing the one page the exporter said it could not write.
 *
 * Structure observed from a real export, and what the walker has to preserve:
 *
 *   The Complete Notebook/            the notebook name is the root folder
 *   ├── Section/                      sections and section groups are folders
 *   │   ├── Page.md                   one file per page
 *   │   └── assets/                   attachments live beside the pages that
 *   │       └── photo.png             reference them, one folder per section
 *   └── Section/Tricky name ).md      names keep spaces, brackets and unicode,
 *                                     and collisions get a _1 suffix
 *
 * Two properties matter more than completeness here. Symlinks are never
 * followed: page titles come from OneNote, so a name is attacker-influenced
 * text, and a walk that resolves links would be a way out of the session
 * directory. And the walk is bounded, because a real vault can hold thousands of
 * pages and a request handler that walks all of them synchronously would stall
 * every other session on the server.
 */

export interface TreeLimits {
  /** Deepest nesting walked. OneNote section groups nest further than people expect. */
  maxDepth: number;
  /**
   * Most entries visited across the whole tree.
   *
   * A folder view is for reading, not for transferring: past a few thousand
   * lines the useful thing is the counts and the download, and a response that
   * big is a better memory problem than it is a feature. The response says it was
   * cut, so a truncated tree is never mistaken for the whole export.
   */
  maxEntries: number;
}

export const DEFAULT_LIMITS: TreeLimits = { maxDepth: 12, maxEntries: 4000 };


/** True for a page rather than an attachment. */
function isPage(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/** Directories before files, then by name. */
function compare(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

interface Budget {
  left: number;
  truncated: boolean;
  maxDepth: number;
}

async function walk(
  absolute: string,
  name: string,
  relative: string,
  depth: number,
  budget: Budget,
): Promise<TreeDir | null> {
  if (depth > budget.maxDepth) {
    budget.truncated = true;
    return null;
  }

  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    // A directory that vanished or cannot be read is not an error worth failing
    // the whole tree over: the user still wants to see everything else.
    return null;
  }

  const children: TreeNode[] = [];
  const node: TreeDir = {
    name,
    path: relative,
    type: 'dir',
    bytes: 0,
    fileCount: 0,
    pageCount: 0,
    assetCount: 0,
    children: [],
  };

  for (const entry of entries) {
    if (budget.left <= 0) {
      budget.truncated = true;
      break;
    }

    // `isSymbolicLink()` is checked first and the link is skipped outright.
    // Nothing in a OneNote export should be a symlink, and following one would
    // let a page name walk the server out of this session's directory.
    if (entry.isSymbolicLink()) {
      budget.truncated = true;
      continue;
    }

    const entryName = entry.name;
    const childRelative = relative === '' ? entryName : `${relative}/${entryName}`;

    if (entry.isDirectory()) {
      budget.left -= 1;
      const child = await walk(join(absolute, entryName), entryName, childRelative, depth + 1, budget);
      if (!child) continue;
      children.push(child);
      node.bytes += child.bytes;
      node.fileCount += 1 + child.fileCount;
      node.pageCount += child.pageCount;
      node.assetCount += child.assetCount;
      continue;
    }

    if (!entry.isFile()) continue;

    budget.left -= 1;
    let bytes: number;
    try {
      bytes = (await stat(join(absolute, entryName))).size;
    } catch {
      continue;
    }
    children.push({ name: entryName, path: childRelative, type: 'file', bytes });
    node.bytes += bytes;
    node.fileCount += 1;
    if (isPage(entryName)) node.pageCount += 1;
    else node.assetCount += 1;
  }

  children.sort(compare);
  node.children = children;
  return node;
}

/**
 * The directory to browse for a session's export.
 *
 * `outPath` is re-checked here even though it was checked when it was stored,
 * because a `state.json` written before that check existed can still hold
 * whatever was in it. Validating on read means the guarantee does not depend on
 * when the file happened to be written.
 */
export function treeRootFor(state: SessionState, dataRoot: string): string | null {
  const paths = sessionPaths(dataRoot, state.guid);
  const reported = state.export.outPath;
  if (!reported) {
    // No usable reported path: browse the output root, which is inside the
    // session by construction. Showing the root when the notebook folder name
    // cannot be derived is the safe direction - at worst one folder too many.
    return paths.outDir;
  }
  const inside = relativeInside(paths.outDir, `${paths.outDir}/${reported}`);
  if (inside === null) return paths.outDir;
  return join(paths.outDir, inside);
}

/** Builds the tree for a session, or an empty result when there is nothing yet. */
export async function buildExportTree(
  state: SessionState,
  dataRoot: string,
  limits: TreeLimits = DEFAULT_LIMITS,
): Promise<ExportTree> {
  const root = treeRootFor(state, dataRoot);
  const empty: ExportTree = {
    root: null,
    truncated: false,
    entries: 0,
    bytes: 0,
    pages: 0,
    assets: 0,
    rootPath: null,
  };
  if (!root) return empty;

  const budget: Budget = { left: limits.maxEntries, truncated: false, maxDepth: limits.maxDepth };
  const node = await walk(root, root.slice(root.lastIndexOf('/') + 1), '', 0, budget);
  if (!node) return empty;

  // The walk counts a directory as an entry too, so the number reported to the
  // user is the number of things they can see.
  const entries = countLeaves(node);
  return {
    root: node,
    truncated: budget.truncated,
    entries,
    bytes: node.bytes,
    pages: node.pageCount,
    assets: node.assetCount,
    rootPath: root,
  };
}

function countLeaves(node: TreeDir): number {
  let total = 1;
  for (const child of node.children) {
    total += child.type === 'dir' ? countLeaves(child) : 1;
  }
  return total;
}