import { useEffect, useState } from 'react';
import type { SessionState } from '@msout-poc/shared';

/**
 * Block 1: sign in.
 *
 * Three states in one block, because they are three states of one operation:
 * the credentials form, an MFA challenge, and the signed-in summary. Which one
 * is shown comes from the server - `state.mfa.kind` - not from a local guess, so
 * a prompt that arrives while the tab is in the background still appears.
 */
export function AuthBlock({
  state,
  guid,
  onSubmit,
  onMfa,
}: {
  state: SessionState;
  guid: string;
  onSubmit: (email: string, password: string) => Promise<void>;
  onMfa: (code: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const loggingIn = state.auth.state === 'logging-in';
  const valid = state.auth.state === 'valid';
  const mfa = state.mfa;

  // The password is held only until it is sent, and the field is cleared
  // immediately afterwards: there is no reason for it to linger in the DOM.
  useEffect(() => {
    if (valid) {
      setPassword('');
      setCode('');
    }
  }, [valid]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!consent || busy) return;
    setBusy(true);
    try {
      await onSubmit(email, password);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      await onMfa(code.trim());
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (mfa.kind === 'number') {
    // Number matching: the user approves on their phone. There is deliberately no
    // Approve button here - the page in the runner waits passively for the
    // element to disappear.
    return (
      <section className="card" aria-live="polite">
        <h2>Approve the sign-in</h2>
        <p className="lead">
          Open Microsoft Authenticator on your phone and approve this sign-in. No code to type.
        </p>
        <p className="mfa-number">{mfa.number ?? '…'}</p>
        <p className="muted">Waiting for the approval…</p>
      </section>
    );
  }

  if (mfa.kind === 'code') {
    return (
      <section className="card" aria-live="polite">
        <h2>Enter your verification code</h2>
        <form onSubmit={sendCode}>
          <label htmlFor="mfa-code">Code from Microsoft Authenticator</label>
          <input
            id="mfa-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
          />
          <div className="row">
            <button type="submit" className="primary" disabled={busy || code.trim() === ''}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </div>
        </form>
      </section>
    );
  }

  if (valid) {
    return (
      <section className="card">
        <h2>Signed in</h2>
        <p className="lead">
          Your Microsoft session is loaded in this session's container. Notebook list is unlocked.
        </p>
        {state.auth.checkedAt && (
          <p className="muted small">Confirmed with Microsoft recently.</p>
        )}
        {state.auth.email && <p className="muted">Signed in as {state.auth.email}</p>}
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Authenticate with Microsoft</h2>
      <p className="muted">
        Unofficial tool. Your credentials go to Microsoft over TLS and are proxied to this session's
        isolated container without being parsed, logged or stored by the server. Microsoft may ask
        for MFA, and may block automated sign-ins from some networks.
      </p>

      <form onSubmit={submit}>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>
            I understand this tool will automatically accept Microsoft&rsquo;s Terms of Use and
            security prompts on my behalf during sign-in.
          </span>
        </label>

        <label htmlFor="email">Microsoft account</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          disabled={loggingIn}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          disabled={loggingIn}
          required
        />

        <div className="row">
          <button
            type="submit"
            className="primary"
            disabled={!consent || loggingIn || email === '' || password === ''}
          >
            {loggingIn ? 'Signing in…' : 'Sign in'}
          </button>
          {!consent && <span className="muted small">Tick the box above to enable sign-in.</span>}
        </div>
      </form>

      {state.auth.state === 'failed' && (
        <p className="alert" role="alert">
          {state.auth.checkedAt
            ? 'Your Microsoft session is no longer valid. Sign in again — anything you already exported is still downloadable below.'
            : 'Sign-in failed. The log below has the details.'}
        </p>
      )}
      {guid === '' && <p className="warn">No session GUID.</p>}
    </section>
  );
}