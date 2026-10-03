import { useState } from 'react';
import type { NotebookRef, SessionState } from '@msout-poc/shared';
import { ExportTree } from './ExportTree';

/**
 * Block 3: export.
 *
 * The progress display is a count, not a percentage: the packages report
 * `Total Pages:` only at the end, so a percentage bar before that point would be
 * a guess presented as a measurement. Once the total appears, the display becomes
 * `n / total`.
 */
export function ExportBlock({
  state,
  selected,
  guid,
  onExport,
  onAbort,
}: {
  state: SessionState;
  selected: NotebookRef | null;
  guid: string;
  onExport: (target: { notebook?: string; notebookUrl?: string }) => Promise<void>;
  onAbort: () => Promise<void>;
}) {
  const [typedName, setTypedName] = useState('');
  const [typedUrl, setTypedUrl] = useState('');

  const authed = state.auth.state === 'valid';
  const exportState = state.export;
  const running = exportState.state === 'running' || exportState.state === 'queued';
  const queued = state.job?.state === 'queued';
  const position = state.job?.position ?? null;

  const target = (): { notebook?: string; notebookUrl?: string } => {
    const url = typedUrl.trim();
    if (url !== '') return { notebookUrl: url };
    // Prefer the URL from the list when there is one: it identifies the notebook
    // exactly, where a name has to be matched against the list server-side.
    if (selected?.url) return { notebook: selected.name, notebookUrl: selected.url };
    const name = typedName.trim() || selected?.name || '';
    return name === '' ? {} : { notebook: name };
  };

  const resolved = target();
  const hasTarget = Boolean(resolved.notebook || resolved.notebookUrl);
  const downloadable = exportState.state === 'done' || exportState.state === 'partial';

  return (
    <section className="card">
      <h2>Export a notebook</h2>

      {!authed && <p className="muted">Sign in above to export a notebook.</p>}

      <label htmlFor="export-notebook">Notebook name</label>
      <input
        id="export-notebook"
        value={selected?.name ?? typedName}
        onChange={(event) => {
          setTypedName(event.target.value);
        }}
        placeholder="Personal"
        disabled={!authed || running}
        spellCheck={false}
      />

      <label htmlFor="export-url">…or paste a notebook URL</label>
      <input
        id="export-url"
        value={typedUrl}
        onChange={(event) => setTypedUrl(event.target.value)}
        placeholder="https://…"
        disabled={!authed || running}
        spellCheck={false}
      />

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={!authed || running || !hasTarget}
          onClick={() => onExport(resolved)}
        >
          {running ? 'Exporting…' : 'Extract notebook'}
        </button>

        {running && (
          <button type="button" className="secondary" onClick={onAbort}>
            Interrupt
          </button>
        )}
      </div>

      {queued && position !== null && (
        <p className="muted">
          Queued — {position === 1 ? 'next' : `${position - 1} ahead of you`}. This POC runs one job
          at a time, so a long export holds everyone else up.
        </p>
      )}

      {running && (
        <p className="progress">
          {exportState.totalPages !== null
            ? `${exportState.pagesExported} / ${exportState.totalPages} pages`
            : `${exportState.pagesExported} pages exported`}
          {exportState.totalPages === null && <span className="muted"> (total unknown until the end)</span>}
        </p>
      )}

      {exportState.state === 'done' && (
        <p className="ok">
          Export complete
          {exportState.totalPages !== null && ` — ${exportState.totalPages} pages`}.
        </p>
      )}

      {exportState.state === 'partial' && (
        <p className="alert">
          Interrupted or incomplete. What was written before the end is downloadable, but this
          notebook is <strong>not</strong> a complete export.
        </p>
      )}

      {exportState.state === 'failed' && (
        <p className="alert">Export failed. The log below has the details.</p>
      )}

      {exportState.error === 'auth_expired' && (
        <p className="alert">
          Your Microsoft session expired. Sign in again above — an export already downloaded is
          unaffected.
        </p>
      )}

      {downloadable && (
        <p>
          <a
            className="button"
            href={`/api/session/artifact?guid=${encodeURIComponent(guid)}`}
            download
          >
            {exportState.partial ? 'Download partial export (.zip)' : 'Download (.zip)'}
          </a>
        </p>
      )}

      {/* What landed on disk, below the download rather than instead of it: the
          zip is what you take away, the tree is what you check.

          Not behind a collapsed disclosure. The export has finished, the user is
          here to find out whether it worked, and making that a second click is a
          question answered with a control. */}
      {downloadable && (
        <div className="tree-panel">
          <h3>What was exported</h3>
          {/* Keyed by job id: a second export remounts the panel and refetches. */}
          <ExportTree key={state.job?.id ?? 'no-job'} guid={guid} />
        </div>
      )}
    </section>
  );
}