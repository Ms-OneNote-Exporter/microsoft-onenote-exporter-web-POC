import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppEvent, SessionState } from '@msout-poc/shared';
import { api, type UiLogLine } from './api';
import { Landing } from './pages/Landing';
import { SessionPage } from './pages/SessionPage';
import { Donate } from './pages/Donate';

/**
 * The whole UI.
 *
 * Three routes decided from `location.pathname`, with no router dependency:
 *   /          landing
 *   /s/:guid   session
 *   /donate    donation targets
 *
 * State lives in one place because the server is authoritative. The browser holds
 * a cache of what it has seen - session state and log lines - and every mutation
 * goes through the API. Nothing is computed here that the server has not already
 * decided, because two implementations of "is this export done?" would drift.
 */

/** Log lines kept in the browser. Matches the server's ring, roughly. */
const MAX_LOG_LINES = 2000;

function route(pathname: string): 'landing' | 'donate' | { session: string } {
  if (/^\/donate\/?$/.test(pathname)) return 'donate';
  const guid = guidFromPath(pathname);
  return guid ? { session: guid } : 'landing';
}

function guidFromPath(pathname: string): string | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  const guid = match?.[1];
  return guid && /^[0-9a-f-]{36}$/i.test(guid) ? guid : null;
}

export function App() {
  const current = useMemo(() => route(window.location.pathname), []);

  if (current === 'donate') return <Donate />;
  if (current === 'landing') {
    return <Landing onNavigate={(g) => window.location.assign(`/s/${g}`)} />;
  }
  return <SessionPage guid={current.session} onErased={() => window.location.assign('/')} />;
}

/**
 * Session state, kept in sync by SSE with a snapshot on connect.
 *
 * `reconnecting` is surfaced rather than hidden: EventSource retries silently,
 * and a user watching a "running" indicator that has stopped receiving events
 * would otherwise conclude the export had stalled.
 */
export function useSession(guid: string): {
  state: SessionState | null;
  logs: UiLogLine[];
  connected: boolean;
  error: string | null;
} {
  const [state, setState] = useState<SessionState | null>(null);
  const [logs, setLogs] = useState<UiLogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The snapshot on connect restores everything, so a refresh mid-export does not
  // need any local persistence - and must not, or a stale tab would disagree
  // with the server.
  const lastId = useRef<number>(0);

  const apply = useCallback((event: AppEvent) => {
    switch (event.type) {
      case 'snapshot':
        lastId.current = 0;
        setState(event.state);
        setLogs([]);
        return;
      case 'log':
        lastId.current = Math.max(lastId.current, event.seq);
        setLogs((current) => {
          const next = [...current, { seq: event.seq, level: event.level, text: event.text, at: '' }];
          return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
        });
        return;
      case 'job-state':
        setState((current) => (current ? { ...current, job: event.job } : current));
        return;
      case 'auth-state':
        setState((current) => (current ? { ...current, auth: event.auth, mfa: event.mfa } : current));
        return;
      case 'mfa-required':
        setState((current) => (current ? { ...current, mfa: event.mfa } : current));
        return;
      case 'notebooks':
        setState((current) => (current ? { ...current, notebooks: event.notebooks } : current));
        return;
      case 'export-progress':
        setState((current) =>
          current
            ? {
                ...current,
                export: { ...current.export, pagesExported: event.pagesExported, totalPages: event.totalPages },
              }
            : current,
        );
        return;
      case 'export-state':
        setState((current) => (current ? { ...current, export: event.export } : current));
        return;
      case 'error':
        setError(event.message);
        return;
      case 'session-erased':
        return;
    }
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | null = null;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      source = new EventSource(
        `/api/session/events?guid=${encodeURIComponent(guid)}${lastId.current ? `&since=${lastId.current}` : ''}`,
      );
      source.onopen = () => setConnected(true);
      source.onmessage = (message) => {
        setConnected(true);
        try {
          const parsed = JSON.parse(message.data) as AppEvent & { seq?: number };
          if (typeof parsed.seq === 'number') lastId.current = Math.max(lastId.current, parsed.seq);
          apply(parsed);
        } catch {
          // A frame we cannot read is dropped; the stream itself is still fine.
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (closed) return;
        // EventSource would retry on its own, but it cannot know the server is
        // gone. A short explicit backoff reconnects with the last id so the
        // stream resumes rather than restarting.
        retry = window.setTimeout(connect, 1500);
      };
    };

    // The snapshot arrives from the stream itself, so a single connection both
    // restores state and delivers updates.
    connect();

    return () => {
      closed = true;
      if (retry !== null) window.clearTimeout(retry);
      source?.close();
    };
  }, [guid, apply]);

  return { state, logs, connected, error };
}

/** Exported for the session page, which needs the same api surface. */
export { api };