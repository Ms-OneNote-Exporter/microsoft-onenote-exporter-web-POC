import { useState } from 'react';
import { isValidGuid } from '@msout-poc/shared';

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
  const [copied, setCopied] = useState(false);

  const candidate = typed.trim() || generated || '';
  const usable = isValidGuid(candidate);

  const generate = () => {
    // crypto.randomUUID, never a shortened or hand-rolled GUID: 122 bits of
    // entropy is the difference between "unguessable" and "probably fine".
    const next = crypto.randomUUID();
    setGenerated(next);
    setTyped('');
    setCopied(false);
  };

  const copy = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the GUID is on screen either way, and the
      // user can select it by hand.
      setCopied(false);
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
            disabled={!usable}
            onClick={() => usable && onNavigate(candidate.toLowerCase())}
          >
            Go to my session
          </button>
        </div>

        {generated && (
          <div className="generated">
            <code>{generated}</code>
            <div className="row">
              <button type="button" onClick={copy} className="secondary small">
                {copied ? 'Copied' : 'Copy GUID'}
              </button>
              <button type="button" onClick={() => onNavigate(generated)} className="primary small">
                Go to my session
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