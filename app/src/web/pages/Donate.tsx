import { useEffect, useState } from 'react';

/**
 * The donate page.
 *
 * Addresses come from the server, which reads them from a file committed to the
 * repository. They are rendered as text with a copy button; nothing here is
 * loaded from a third party, because the whole page is inside a CSP that forbids
 * it and a donation widget would have to break that promise.
 */
interface DonateConfig {
  missing?: boolean;
  fiat: { label: string; href: string }[];
  crypto: { symbol: string; address: string }[];
}

export function Donate() {
  const [config, setConfig] = useState<DonateConfig | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/donate', { headers: { accept: 'application/json' } })
      .then((response) => response.json())
      .then((body: DonateConfig) => {
        if (!cancelled) setConfig(body);
      })
      .catch(() => {
        if (!cancelled) setConfig({ fiat: [], crypto: [], missing: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async (symbol: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(symbol);
    } catch {
      setCopied(null);
    }
  };

  return (
    <main className="landing">
      <h1>Donate</h1>
      <p className="lead">
        This service is unofficial and free. Donations cover hosting — a headless browser per
        export is not free, and neither is the disk your exported notebooks occupy until they are
        erased.
      </p>

      {!config && <p className="muted">Loading…</p>}

      {config?.missing && (
        <p className="alert">Donation details are not configured on this instance.</p>
      )}

      {config && !config.missing && (
        <>
          <section className="card">
            <h2>Card or PayPal</h2>
            <ul className="notebooks">
              {config.fiat.map((entry) => (
                <li key={entry.href}>
                  <a className="button" href={entry.href} target="_blank" rel="noreferrer noopener">
                    {entry.label}
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Crypto</h2>
            <ul className="notebooks">
              {config.crypto.map((entry) => (
                <li key={entry.symbol}>
                  <div className="generated">
                    <code>
                      {entry.symbol}: {entry.address}
                    </code>
                    <div className="row">
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => copy(entry.symbol, entry.address)}
                      >
                        {copied === entry.symbol ? 'Copied' : 'Copy address'}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <p className="muted">
            The addresses live in the project&rsquo;s repository, not in this instance&rsquo;s
            configuration, so anyone can check which addresses are live. Nothing about how your data
            is handled changes based on whether you donated — there is no account and no link
            between a donation and a session.
          </p>
          <a className="button" href="/">
            Back to the exporter
          </a>
        </>
      )}
    </main>
  );
}