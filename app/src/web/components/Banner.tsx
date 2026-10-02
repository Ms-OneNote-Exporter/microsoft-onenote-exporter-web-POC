import { useEffect, useState } from 'react';
import type { SessionState } from '@msout-poc/shared';

/**
 * The countdown, erase confirmation and the two links.
 *
 * The remaining time is computed from the server's absolute `expiresAt` rather
 * than from a locally started timer, so a skewed client clock cannot make a
 * session look longer-lived than it is.
 */
export function Banner({
  state,
  connected,
  onErase,
}: {
  state: SessionState;
  connected: boolean;
  onErase: () => void;
}) {
  const [remaining, setRemaining] = useState(() => msUntil(state.expiresAt));
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setRemaining(msUntil(state.expiresAt));
    const timer = window.setInterval(() => setRemaining(msUntil(state.expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [state.expiresAt]);

  return (
    <header className="banner">
      <div className="banner-left">
        {confirming ? (
          <span className="confirm">
            <span>Delete everything this session stored?</span>
            <button type="button" className="danger small" onClick={onErase}>
              Yes, erase
            </button>
            <button type="button" className="secondary small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className="secondary small" onClick={() => setConfirming(true)}>
            Erase session
          </button>
        )}
        <span className="guid" title="Session GUID">
          {state.guid.slice(0, 8)}…
        </span>
      </div>

      <div className="banner-right">
        {!connected && <span className="warn small">reconnecting…</span>}
        <span className={`countdown${remaining <= 0 ? ' expired' : ''}`}>
          {remaining <= 0 ? 'expired' : formatDuration(remaining)}
        </span>
        <a href="https://github.com/Ms-OneNote-Exporter" target="_blank" rel="noreferrer noopener">
          GitHub
        </a>
        <a href="/donate">Donate</a>
      </div>
    </header>
  );
}

function msUntil(iso: string): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 0;
  return Math.max(0, at - Date.now());
}

/** `11h 59m`, then `59m 12s`. No days: a session is 12 hours. */
function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}