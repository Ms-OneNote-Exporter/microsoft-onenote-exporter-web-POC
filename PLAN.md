# microsoft-onenote-exporter-web

An online, anonymous, one-shot service that exports a Microsoft OneNote notebook
to Obsidian-flavoured Markdown, using the four existing `@msout` packages.

- No account, no email, no username. A **GUID** is the session.
- A session lives **12 hours**, fixed, from the moment the GUID is created.
- Credentials never pass through application code.
- Every session gets its own **destroyed-on-expiry container**.

Built on top of:

| Package | Role |
|---|---|
| [`@msout/microsoft-webauth`](https://github.com/Ms-OneNote-Exporter/microsoft-webauth) | Microsoft login, produces `auth.json` |
| [`@msout/microsoft-onenote-list-notebooks`](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export) | Lists notebooks from an `auth.json` |
| [`@msout/microsoft-onenote-export-notebook`](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook) | Exports one notebook to Markdown |
| [`@msout/microsoft-onenote-exporter`](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-exporter) | The umbrella project this service belongs to |

---

## 1. Decisions

The plan below is built on these answers. They are the contract; later sections
refer back to them.

| Area | Decision |
|---|---|
| Credentials | Browser POSTs **directly into the session container**. Never through app-server memory. |
| MFA / challenges | Pluggable prompt in `microsoft-webauth`; **stdin kept as the CLI fallback**. |
| Isolation | One container per GUID session, up to **12**, destroyed on erase or expiry. |
| Session secret | **GUID alone** in v1. GUID + 256-bit secret planned for v2. |
| Hosting | Single VPS, `docker compose` + Caddy. 48 GB RAM. |
| Packages | Extended in place, versions bumped, consumed from npm. |
| New code | This repo. TypeScript, Fastify + React. Public. |
| Pool semantics | A slot **is** a GUID session, held a fixed 12h. |
| Pool exhausted | Countdown to earliest expiry. No address collected, v1. |
| Auth validity | `auth.json` existence is trusted for the life of the session. |
| Download | Zip built in-container, **reusable link** until session end. |
| Long export | Stay on page, **live SSE logs**, interrupt button. |
| Concurrency | 12 containers; ~8 concurrent exports, remainder queue in-session. |
| Protected sections | **Skipped**, placeholders preserved in output. |
| Erase | Remove container + delete directory. LUKS planned for v2. |
| Abuse | IP rate limits, no captcha. |
| Deploy | Public repo, GHCR images, CI runs `compose pull && up`. |

---

## 2. The container pool

Twelve pre-warmed, **unclaimed** runner containers exist at any time.

- Creating or entering a GUID **claims one idle runner** in ~100 ms.
- That runner is then **owned by that GUID for the full 12 h**, whether the user
  is actively exporting or has been idle for eleven hours.
- Idle runner: ~200 MB RSS. Runner mid-export: ~1–1.5 GB.
  Worst case 12 × 1.5 GB ≈ **18 GB against 48 GB**. Comfortable.

### Known cost of this model

A user who authenticates once and disappears **holds a slot for 12 hours**.
Twelve such users lock out the service for 12 hours. This was a deliberate
choice ("slot = GUID session"), and it is the right default, but it is the
first thing likely to need revisiting. See §11.

### When the pool is empty

The pool-full page shows `next slot free in MM:SS`, computed as
`min(expiresAt) - now` across active sessions. If that is more than about two
hours away, additionally show: *"sessions are held for 12 h — if you already
have a GUID, you can go straight to your session."*

Entering a GUID that is unknown or already expired does **not** create anything.
It reports the session as unknown or expired. Sessions are never resurrected.

### State ownership

The GUID → runner mapping is recorded as **Docker labels**:

```
msout.session.guid
msout.session.expires
msout.session.state
msout.session.notebook
```

The registry is therefore rebuilt from `docker ps` on boot, and an app restart
neither orphans nor loses live sessions. A small SQLite file mirrors the same
data for fast point lookups and for the pool-full countdown.

---

## 3. Architecture

```
┌──────────────────────────────────────────────┐
│ browser ──────────▶ Caddy  (TLS, routes only) │
└───────────────────────────┬──────────────────┘
                            │
   /  and  /session/:guid/*   │  static UI, no secrets
                            │
                 ┌──────────▼───────────────────┐
                 │ app  (Fastify, TypeScript)   │
                 │  • pool + session registry    │
                 │  • SSE log fan-out            │
                 │  • /api/*  /files/*           │
                 └──────────┬───────────────────┘
                            │
                     docker network only
        ┌───────────┬───────┴───────┬───────────┬───────────┐
   runner-1   runner-2      runner-3   runner-4    …      runner-12
   (one per GUID session)
```

### Runner sidecar

Each runner image carries a small Fastify sidecar alongside the `@msout` packages:

| Route | Purpose |
|---|---|
| `POST /login` | `{email, password}` → `login({ promptCode, onEvent, signal })` |
| `GET /status` | auth state, notebook list cache |
| `POST /logout` | clears `auth.json` |
| `POST /notebooks/list` | `listNotebooks({ authFile })` |
| `POST /export` | `{notebook \| notebookLink}` → `runExport({ signal, onEvent })` |
| `GET /export/:id/events` | SSE: progress, log lines, completion |
| `POST /export/:id/abort` | interrupt |
| `GET /artifacts/:id.zip` | download, `Accept-Ranges` supported |
| `POST /erase` | wipe session directory |

### The credential path

The password must **bypass the app entirely**. Caddy routes
`POST /s/:guid/cred` straight to the runner, not through the Fastify router.
Otherwise Fastify holds every user's Microsoft password in its heap.

Even then, Caddy touches the bytes as an HTTP proxy. This is unavoidable unless
TLS terminates inside the runner. So the honest claim for the privacy note is:

> The password is **never persisted, never logged, and never seen by
> application code**.

It is *not* "the password never exists in RAM". Say it the first way.

Request-body logging must be **off** in both Caddy and Fastify, and asserted in
CI. See §9.

---

## 4. The runner image

Single image, built from this repo, published to GHCR. Contains:

- Node 24 (pinned, matching the existing packages' base)
- Playwright Chromium + system deps
- all four `@msout` packages from npm
- `zip`
- the Fastify sidecar

### Runtime hardening

Per runner container:

```
--read-only                      # + tmpfs on /tmp and the Playwright cache
--cap-drop=ALL
--security-opt=no-new-privileges
--pids-limit=<n>
--memory=2g
--cpus=2
--network=<session-network>      # no docker socket, no host network
--user=node
```

Set `ONENOTE_EXPORT_LOG_DIR=/data/logs`.

### Do not pass `--no-sandbox` to Chromium

It works, and it is the tempting default inside containers. It also disables the
renderer sandbox — which is the entire reason for putting untrusted notebook
content in an isolated browser in the first place.

Instead, enable unprivileged user namespaces on the host:

```
kernel.unprivileged_userns_clone=1
kernel.apparmor_restrict_unprivileged_userns=0
```

and let Chromium's own sandbox operate. **This is the single most important
security decision in the project and the easiest to get wrong by accident.**

### Never enable `--dodump` / `--screenshot`

Per the export-notebook README, dumps contain authenticated DOM with live
cookies and tenant hostnames. Both flags are for local debugging and must stay
off in the service. There is no debug override.

---

## 5. Changes to the four packages

All additive, all backwards compatible, all released before this service needs
them.

### `microsoft-webauth` 0.1.8 → 0.2.0

```ts
login({
  email, password,
  authFile,
  promptCode?,   // (challenge) => Promise<string>; absent ⇒ today's stdin path
  onEvent?,      // (event) => void
  signal?,       // AbortSignal
})
```

- `promptCode` is a **default parameter**, not a module-level setter. A module
  global would leak between concurrent sessions sharing one Node process.
- The challenge payload is richer than a string, because number-matching MFA
  needs the two numbers shown to the user:

  ```ts
  type Challenge =
    | { kind: 'code'; label: string }              // OTC / SMS / authenticator
    | { kind: 'number-match'; numbers: [number, number] }
  ```

  The UI resolves with the code string, or with `'approve'` for number-match, and
  the sidecar taps **Accept** in the page.
- `signal` aborts a login cleanly and tears the browser down.
- `onEvent` emits `challenge`, `progress`, `screen` — this is what SSE forwards.

**CLI unchanged.** `microsoft-webauth login --email … --password …` with no
`promptCode` still reads `process.stdin` exactly as today. Existing tests pass
untouched.

### `microsoft-onenote-export-notebook` 0.3.7 → 0.4.0

```ts
runExport({
  authFile, notebook | notebookLink, outputDir,
  signal?,       // AbortSignal — the interrupt button
  onEvent?,      // page | section | group | asset | done | partial
})
```

- On abort: stop traversal, **keep what is already on disk**, exit cleanly, mark
  the artifact partial so the UI can still offer a download.
- `onEvent` carries counts, so the UI can render a real progress bar rather than
  counting log lines.

Already available and reused unchanged: `--non-interactive`, exit codes
`0/1/2/3`, `ONENOTE_EXPORT_LOG_DIR`, log rotation.

### `microsoft-onenote-list-notebooks`

Likely **no changes**. `listNotebooks({ authFile })` is sufficient. Confirm
whether it accepts a `signal` if cancel-on-navigation is wanted; if not, add it.

### `microsoft-onenote-exporter`

Untouched.

### Note on `entrypoint.sh`

The existing `entrypoint.sh` in export-notebook becomes the **reference** for
the sidecar rather than the runtime path — but it keeps working. It is the
documented unattended container path and other users depend on it.

---

## 6. Front end

Fastify serves a React build. No third-party JS, no analytics, no tracking.

### Landing

GUID text input plus **generate for me**. Generate uses `crypto.randomUUID()`.

The generated GUID is shown with a copy button and an explicit warning —
*"this is your key, save it, we cannot recover it"* — before offering **go to
my session**. Entering an existing GUID goes straight to page B.

### Page B

Sticky top banner:

- **erase session** → inline confirmation div, not a modal route
- **github project** → opens the repo in a new tab
- **donate** → §8
- countdown timer to session expiry

Three blocks:

1. **Authenticate with Microsoft** — email + password form. On a challenge
   event from SSE, the block swaps to a verification-code input, or a
   number-matching approval view.
2. **List notebooks** — greyed out until `auth.json` exists. Result is a list of
   notebook names; clicking one fills block 3's input.
3. **Export one notebook** — greyed out until `auth.json` exists. Accepts a
   notebook name or a notebook URL. **Extract notebook** starts the run; a live
   log panel streams over SSE; an **interrupt** button aborts it. On completion
   a download link appears.

### Headers

```
Referrer-Policy: no-referrer
Cache-Control: no-store          # /session/* and /files/*
```

Because the GUID is the **only** credential in v1, application logs record a
**SHA-256 prefix** of the GUID, never the raw value. An attacker with the logs
still cannot reconstruct it.

---

## 7. Work sequence

1. **Package changes first, with tests.** `promptCode`, `signal`, `onEvent` in
   both packages. Published as 0.2.0 / 0.4.0. Nothing else can be built on
   unverified ground.
2. **Runner image + sidecar.** A single container drivable with `curl`. Prove
   login → list → export → abort → zip → erase end to end **before any UI
   exists**.
3. **App**: pool + registry + routing, then SSE fan-out, then download serving
   with Range support.
4. **React front end**: landing → page B → export flow.
5. **Caddy + compose + GHCR + CI deploy.**
6. **Hardening pass**: no-referrer, no-store, no access logs on session routes,
   rate limits, Chromium sandbox verified working, disk-full behaviour.
7. **Donate route** and the GitHub link. Trivial; do them late.

Steps 1 and 2 carry the risk. Everything after is ordinary web work.

---

## 8. Donations

A static route inside the app, `/donate`.

- Addresses and the PayPal link come from a config file or environment, so they
  can be changed without a rebuild.
- BTC / TAO / ETH / SOL.
- No third-party JS on that page.
- A short, honest note on what the money pays for: the VPS and the domain.

---

## 9. Security checklist

- [ ] Chromium sandbox **enabled** — verify, do not assume
- [ ] `--cap-drop=ALL`, `no-new-privileges`, read-only rootfs, tmpfs writable paths
- [ ] No docker socket in any runner
- [ ] Request-body logging disabled in **both** Caddy and Fastify; asserted in CI
- [ ] `Referrer-Policy: no-referrer` on all session and file routes
- [ ] `Cache-Control: no-store` on all session and file routes
- [ ] Raw GUIDs never written to logs — SHA-256 prefix only
- [ ] `--dodump` / `--screenshot` unreachable from the service
- [ ] Rate limits per IP: ~3 sessions and 5 exports per hour
- [ ] IP stored truncated or hashed for the limiter only, never in full
- [ ] TLS via Caddy, HSTS on
- [ ] Expiry sweep runs every 30 s and on boot
- [ ] Disk-full behaviour: export fails cleanly, partial kept, session survives

---

## 10. Open risks

| Risk | Mitigation |
|---|---|
| 12 careless sessions lock out the service for 12 h | Accepted for v1. Idle-TTL is the v1.1 fix (§11). |
| Password leaks into logs | Body logging off, CI assertion, §9 checklist |
| "Erase" is `rm -rf`, not a cryptographic erase | Stated plainly in the UI — §11 |
| Service is used to drive Microsoft logins at scale | IP rate limits, no captcha |
| Container pool leaks memory over weeks | Registry rebuild from `docker ps` + boot reconciliation |
| Zip artefact consumes all disk | Per-session quota, disk-full behaviour in §9 |

---

## 11. Deferred to v2

- **GUID + 256-bit high-entropy secret.** The GUID stays the identifier; a
  separate secret authorises. A leaked URL becomes inert. Today the URL *is* the
  credential, which is why the no-referrer and no-store headers are load-bearing
  rather than hygiene.
- **Encrypted volumes with LUKS.** Erase destroys the key, so data is
  unrecoverable from the underlying disk — the only true cryptographic erase.
- **Idle-TTL shorter than the session.** Keep session data for 12 h but stop the
  container after a few idle minutes. Cuts RAM dramatically and reduces the
  stuck-slot problem, at the cost of restart latency and possible re-login.
- **Email notification when a slot frees.** Requires an SMTP relay and turns a
  stateless service into one holding personal data.

### Wording to get right

"Erase session" in v1 deletes everything the service stored, via container
removal and directory deletion. It is **not** a cryptographic erase, and on CoW
or SSD storage old blocks may persist. The confirmation text should say
*"we deleted everything we stored"* — never *"nothing remains anywhere"*.

---

## 12. Licence and relationship to the other repos

MIT, consistent with the rest of the family. This repo consumes the four
packages from npm and does not fork them.

The Microsoft Terms of Use and security-info interstitial screens are accepted
automatically by `microsoft-webauth` on the user's behalf — this is existing,
documented behaviour of that package. **The front end must say so plainly**
before the password form, because it is a real change to the user's account that
they are not watching happen.