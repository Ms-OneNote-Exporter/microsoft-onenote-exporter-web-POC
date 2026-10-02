import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionState } from '@msout-poc/shared';
import { api, type UiLogLine } from '../api';
import { useSession } from '../App';
import { Banner } from '../components/Banner';
import { AuthBlock } from '../components/AuthBlock';
import { NotebooksBlock } from '../components/NotebooksBlock';
import { ExportBlock } from '../components/ExportBlock';
import { LogPanel } from '../components/LogPanel';

/**
 * Page B: the three blocks and the banner.
 *
 * Nothing here decides anything the server has not already decided. Progress,
 * state and errors all arrive over SSE; the local state is only what the user
 * is currently typing.
 */
export function SessionPage({ guid, onErased }: { guid: string; onErased: () => void }) {
  const { state, logs, connected, error } = useSession(guid);
  const [selected, setSelected] = useState<{ name: string; url: string | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  // A session that was erased or has expired must not keep rendering as if it
  // were alive. One check on mount is enough: the server answers 404 and the
  // stream closes.
  useEffect(() => {
    let cancelled = false;
    api
      .readSession(guid)
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [guid]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError((caught as Error).message);
    }
  }, []);

  const erase = useCallback(async () => {
    await run(async () => {
      await api.erase(guid);
      onErased();
    });
  }, [guid, onErased, run]);

  if (missing) {
    return (
      <main className="landing">
        <h1>No such session</h1>
        <p className="lead">
          This session has expired or been erased. Sessions last 12 hours and are deleted when you
          erase them; there is no way to recover one.
        </p>
        <a className="button" href="/">
          Start a new session
        </a>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="session">
        <p className="lead">Loading your session…</p>
      </main>
    );
  }

  const message = actionError ?? error;

  return (
    <main className="session">
      <Banner state={state} connected={connected} onErase={erase} />

      {message && (
        <p className="alert" role="alert">
          {message}
        </p>
      )}

      <AuthBlock
        state={state}
        guid={guid}
        onSubmit={(email, password) => run(() => api.login(guid, email, password))}
        onMfa={(code) => run(() => api.mfa(guid, code))}
      />

      <NotebooksBlock
        state={state}
        onList={() => run(() => api.list(guid))}
        onSelect={(notebook) => {
          setSelected(notebook);
          // A name and a URL for the same notebook are not interchangeable: the
          // URL identifies it exactly, so the export uses it when present.
          document.getElementById('export-notebook')?.focus();
        }}
        selected={selected}
      />

      <ExportBlock
        state={state}
        selected={selected}
        guid={guid}
        onExport={(target) => run(() => api.exportNotebook(guid, target))}
        onAbort={() => run(() => api.abort(guid))}
      />

      <LogPanel logs={logs} connected={connected} />
    </main>
  );
}

/** Re-exported so the page and its children agree on the state type. */
export type { SessionState, UiLogLine };