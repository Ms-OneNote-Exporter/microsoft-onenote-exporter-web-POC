import { useEffect, useRef, useState } from 'react';
import type { UiLogLine } from '../api';

/**
 * The live log.
 *
 * Auto-scrolls unless the user has scrolled up, because yanking someone back to
 * the bottom while they are reading an error is a small way of making the tool
 * feel broken. Log text is rendered as text content, never as markup: it comes
 * from a third-party package and may contain anything OneNote produced.
 */
export function LogPanel({ logs, connected }: { logs: UiLogLine[]; connected: boolean }) {
  const [follow, setFollow] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, follow]);

  const onScroll = () => {
    const el = endRef.current?.parentElement;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  };

  return (
    <section className="card log">
      <div className="log-header">
        <h2>Log</h2>
        {!connected && <span className="warn small">reconnecting…</span>}
        {!follow && (
          <button type="button" className="secondary small" onClick={() => setFollow(true)}>
            Jump to latest
          </button>
        )}
      </div>

      <div className="log-body" onScroll={onScroll}>
        {logs.length === 0 && <p className="muted">Nothing yet.</p>}
        {logs.map((line) => (
          <div key={line.seq} className={`log-line ${line.level}`}>
            <span className="log-level">{line.level}</span>
            <span className="log-text">{line.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}