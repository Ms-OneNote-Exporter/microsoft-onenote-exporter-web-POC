import { useState } from 'react';
import { isValidGuid } from '@msout-poc/shared';
import { api } from '../api';

/**
 * The landing page.
 *
 * One input and two buttons. The generated GUID is shown with a copy button and
 * an explicit warning that it cannot be recovered, because there is no reset and
 * no email to fall back on - a user who loses it loses the session.
 */
export function Landing({ onNavigate }: { onNavigate: (guid: string) => void }) {
  const [typed, setTyped] = useState('');
  const [generated, setGenerated] = useState<string | null>(null);
  /** 'copied' | 'selected' | null - what the button should say. */
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidate = typed.trim() || generated || '';
  const usable = isValidGuid(candidate);

  /**
   * Creates the session, then goes to it.
   *
   * The POST is what makes the GUID real. Generating it in the browser and
   * navigating straight to `/s/<guid>` looked fine and was not: nothing had
   * created the session, so the session page correctly reported "no such
   * session" - the GUID was a string and nothing more. Same for a GUID pasted in
   * by hand, which the spec says should open a session.
   *
   * The POST is idempotent: an existing session is opened, not reset.
   */
  const start = async (guid: string) => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await api.createSession(guid.toLowerCase());
      onNavigate(guid.toLowerCase());
    } catch (caught) {
      setError((caught as Error).message);
      setStarting(false);
    }
  };

  const generate = () => {
    // crypto.randomUUID, never a shortened or hand-rolled GUID: 122 bits of
    // entropy is the difference between "unguessable" and "probably fine".
    const next = crypto.randomUUID();
    setGenerated(next);
    setTyped('');
    setCopied(null);
  };

  /**
   * Copies the GUID, falling back to selecting it.
   *
   * `navigator.clipboard` needs transient user activation, so it throws for a
   * synthetic click, for a denied permission, and in some embedded browsers. In
   * every one of those cases the previous behaviour was to do nothing visible,
   * which reads as a broken button. The fallback selects the text instead, so the
   * user's next keystroke - Cmd-C - does the job.
   */
  const copy = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated);
      setCopied('copied');
    } catch {
      const node = document.getElementById('generated-guid');
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied('selected');
    }
  };

  return (
    <main className="landing">
      <h1>Export a OneNote notebook</h1>
      <p className="lead">
        No account. A session lasts 12 hours and is tied only to a GUID — nobody here knows who
        you are, and there is no password to reset.
      </p>

      <section className="card">
        <label htmlFor="guid">Session GUID</label>
        <input
          id="guid"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setGenerated(null);
          }}
          placeholder="00000000-0000-0000-0000-000000000000"
          spellCheck={false}
          autoComplete="off"
        />

        {typed.trim() !== '' && !usable && (
          <p className="warn">That does not look like a GUID.</p>
        )}

        <div className="row">
          <button type="button" onClick={generate} className="secondary">
            New session
          </button>
          <button
            type="button"
            className="primary"
            disabled={!usable || starting}
            onClick={() => usable && void start(candidate)}
          >
            {starting ? 'Starting…' : 'Go to my session'}
          </button>
        </div>

        {error && (
          <p className="alert" role="alert">
            Could not start the session: {error}
          </p>
        )}

        {generated && (
          <div className="generated">
            <code id="generated-guid">{generated}</code>
            <div className="row">
              <button
                type="button"
                onClick={copy}
                className="secondary small"
                // Says what happened, so the button is never a dead end.
                aria-live="polite"
              >
                {copied === 'copied' ? 'Copied' : copied === 'selected' ? 'Copy: press ⌘C' : 'Copy GUID'}
              </button>
              <button
                type="button"
                onClick={() => void start(generated)}
                className="primary small"
                disabled={starting}
              >
                {starting ? 'Starting…' : 'Go to my session'}
              </button>
            </div>
            <p className="warn">
              Copy it now. If you lose this GUID the session is unreachable — there is no way to
              recover it, and nobody can find it for you.
            </p>
          </div>
        )}
      </section>

      <footer className="landing-footer">
        <a href="https://github.com/Ms-OneNote-Exporter" target="_blank" rel="noreferrer noopener">
          Project on GitHub
        </a>
        <a href="/donate">Donate</a>
      </footer>
    </main>
  );
}