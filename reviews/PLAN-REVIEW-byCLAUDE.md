# PLAN Review — microsoft-onenote-exporter-web
> Reviewed by Claude Sonnet 4.6 (Thinking) — 2026-10-02

---

## Overall Impression

The plan is unusually mature for a pre-code document. The decisions table is
honest, the threat model is explicit, and the "known cost" callout in §2 is the
kind of self-awareness that most plans lack. The work sequence in §7 is correct
(packages first, then sidecar, then app). The security checklist is good.

The issues below are not blocking, but several of them will bite if not addressed
before launch.

---

## 🔴 High — Flows or decisions that are likely to cause real problems

### 1. The password path through Caddy is still a credential leak vector

The plan correctly identifies that Caddy touches the password bytes as a proxy,
then softens the claim to *"never persisted, never logged, never seen by
application code"*. That wording is fine for a privacy notice, but the
**implementation must be enforced, not stated**:

- Caddy's default access log includes the request body size and path. If someone
  adds a `log` directive to the Caddyfile at any point (common debugging habit),
  passwords reappear in logs.
- The CI assertion mentioned in §9 only catches body-logging in code. It cannot
  catch a sysadmin adding `log` to Caddy manually.

**Suggestion:** Explicitly document in `Caddyfile` comments that the `/s/:guid/cred`
block must **never** have a `log` directive, and add a CI step that `grep`s the
final rendered Caddyfile for `log {` near that route. Alternatively, strip the
body entirely in a Caddy middleware before forwarding, so there is nothing to
log even if logging is accidentally enabled.

---

### 2. GUID-as-credential is weaker than the plan implies, and v2 may never ship

§6 says `Referrer-Policy: no-referrer` and `Cache-Control: no-store` are
"load-bearing rather than hygiene." That is correct — but they only protect
against *passive* leakage. Active vectors remain:

- The GUID appears in the **browser address bar** (`/session/<guid>/…`). Any
  screenshot, screen-share, or shoulder-surf exposes it.
- The GUID is in browser history, which syncs across devices by default in
  Chrome/Firefox.
- The session URL in any open tab is visible to any browser extension with
  `tabs` permission.

The plan defers the 256-bit secret to v2, but v2 features often ship never.
Consider making the threat model explicit in the README rather than only in code
comments, so users understand the risk before they enter their Microsoft password.

**Suggestion:** Add a v1 mitigation that is cheap: after a successful auth, offer
a **"lock this session to this browser"** link that sets an `HttpOnly` cookie
alongside the GUID. The cookie + GUID must both be present. No crypto, no v2
work — just a cookie. This closes the screenshot/history vector for users who opt
in.

---

### 3. Session slot claim race condition

The plan says entries are looked up via Docker labels, with SQLite as a fast
mirror. But between the `docker ps` rebuild on boot and the SQLite mirror being
written, there is a brief window where an in-flight GUID could be double-claimed
if two requests race. With 12 slots the probability is low, but not zero.

**Suggestion:** Claim slots with a **single atomic SQLite transaction** (INSERT
OR IGNORE on the GUID as primary key, then check affected rows). If rows = 0,
the claim failed; return pool-full or already-claimed error. Docker labels then
become the recovery source on reboot, not the primary source during runtime.

---

### 4. MFA / challenge flow is underspecified for the UI

The sidecar emits a `challenge` event over SSE. Page B "swaps the block to a
verification-code input." But the plan does not address:

- **Timeout**: Microsoft's MFA challenges expire (typically 30–60 s for OTC,
  up to 2 min for number-match). If the user is slow, the login fails with an
  opaque error. The UI must show a countdown or an explicit "code expired"
  message.
- **Retry**: After a failed MFA, is the user expected to click "authenticate"
  again from scratch? The sidecar must emit a clear `challenge-failed` or
  `auth-failed` event, not just drop the SSE stream.
- **Number-match UI**: The two numbers must be shown in the browser **and** in
  the Microsoft Authenticator app simultaneously. The UI must make this match
  obvious (large font, clear instruction). Easy to get wrong.

---

### 5. Zip artifact served through the app wastes memory

`GET /artifacts/:id.zip` goes runner → app → browser. For a large notebook this
could be several GB. The app holds the full response body in memory (or at least
the socket buffer) even though the runner supports `Accept-Ranges`.

**Suggestion:** Serve the zip directly from Caddy using a `file_server` that
maps `/files/:guid/…` to the container's mounted data directory, skipping the
app entirely for downloads. The app only needs to validate that the GUID owns
the requested path, which can be a cheap redirect. This is consistent with the
credential bypass pattern already in the plan, just applied to files.

---

## 🟡 Medium — Real issues that will cause friction, not necessarily breakage

### 6. Export concurrency per session is unstated

> *"~8 concurrent exports, remainder queue in-session."*

"Queue in-session" means what exactly? If two browser tabs for the same GUID
both click "Extract notebook" at once, does the second call fail, queue, or
silently win? The sidecar route `POST /export` does not have a stated locking
mechanism.

**Suggestion:** State explicitly (and enforce in the sidecar) that only one export
can run per session at a time. A second `POST /export` while one is active should
return 409. The UI should disable the button while an export is running.

---

### 7. SSE fan-out architecture is underspecified

> *"SSE log fan-out"* is listed as an app responsibility.

Questions not answered:
- The runner emits events on `GET /export/:id/events`. The app re-emits them
  to the browser on… what route? `/api/session/:guid/events`?
- If the user refreshes during an export, does the app replay buffered events
  or does the browser start from "now"?
- How long does the app buffer events? Unbounded buffers with a verbose export
  log could consume significant app memory over a 12-hour session.

**Suggestion:** Add a short SSE section specifying: route name, buffer strategy
(e.g. last-N lines, no replay, or full replay), and reconnection behaviour. The
browser `EventSource` API reconnects automatically; the app must handle the
`Last-Event-ID` header and replay from that point, or explicitly state it does
not support replay and the UI shows "reconnecting…" instead.

---

### 8. Erase is not transactional

*"Remove container + delete directory"* are two separate operations. If the
container removal succeeds but directory deletion fails (disk quota, permission
issue), session data persists with no container to own it and no TTL to clean
it up.

**Suggestion:** Reverse the order: delete the directory first, then remove the
container. If directory deletion fails, the user is told and the container is
kept so they can retry. Also: the expiry sweep should include orphaned directories
(present on disk, no matching container label).

---

### 9. Rate limiting is too coarse for the stated threat model

> *"~3 sessions and 5 exports per hour"*

- 3 sessions per IP means four IPs (or one with rotating proxies) can fill all
  12 slots.
- 5 exports per session is not bounded globally: 12 × 5 = 60 concurrent export
  attempts the system was not sized for.
- IPv6 makes per-IP limiting trivially bypassable.

**Suggestion:** Add a global cap on new sessions per hour (e.g. 20/h regardless
of IP diversity), use /24 buckets for IPv4, and document the IPv6 limitation
explicitly in §10 risks.

---

### 10. `auth.json` trust is permanent, but Microsoft tokens expire

Microsoft access tokens expire in ~1 hour. If the user leaves the session idle
for several hours, `listNotebooks` or `export` will fail with a 401, not a
"please re-authenticate" message. The sidecar has no token refresh logic
mentioned.

**Suggestion:** Either (a) catch 401s in the sidecar, attempt a silent refresh
via `microsoft-webauth` if it supports it, and emit an `auth-expired` event if
not; or (b) document clearly that sessions idle >1 h may need to re-authenticate,
and have the UI warn before export starts.

---

### 11. Countdown timer assumes clock sync between server and browser

The session expiry is stored as an absolute timestamp. The countdown
`min(expiresAt) - now` is computed server-side but displayed client-side. NTP
drift can make the displayed countdown wrong.

**Suggestion:** Return `expiresAt` as an ISO-8601 string from the API; the
browser computes `expiresAt - Date.now()` locally. No clock sync dependency.

---

### 12. `--read-only` rootfs with Playwright is notoriously tricky

Playwright Chromium writes to several directories at runtime: browser profile
dir, crash dumps, GPU cache, and the Playwright cache itself. If any of these
hit the read-only rootfs, Chromium silently falls back or crashes. The plan
mentions `tmpfs on /tmp and the Playwright cache` but the full list of writable
paths is broader.

**Suggestion:** Add an integration test that launches Playwright inside the
hardened container and verifies it starts successfully. Do this in §7.2 before
any UI work.

---

## 🟢 Low — Style, clarity, or minor improvements

### 13. SQLite missing from the architecture diagram

§2 mentions SQLite as a mirror for fast lookups and the pool countdown. The
§3 architecture diagram only shows Caddy → Fastify → runners. SQLite should
appear as a component of the app server box.

### 14. `listNotebooks` signal gap is a blocker disguised as a note

> *"Likely no changes. Confirm whether it accepts a signal."*

If `listNotebooks` does not accept a `signal` and the user navigates away, the
underlying HTTP call hangs until Microsoft times out (30+ seconds). This should
be a **blocker before §7.2**, confirmed before any sidecar work starts.

### 15. React must be self-hosted, not CDN-linked

§6 says "no third-party JS." If the build accidentally uses a CDN-hosted React
(a common shortcut), that contradicts the privacy claim. Explicitly state that
the React bundle must be fully included in the GHCR image and served from the
app itself.

### 16. ToS auto-acceptance needs a checkbox, not just text

> *"The front end must say so plainly before the password form."*

"Say so plainly" may not be sufficient in some jurisdictions where automated
acceptance of amended terms requires explicit user consent. Consider a checkbox:
*"I understand that microsoft-webauth will accept Microsoft's ToS interstitials
on my behalf."* One click, zero friction, cleaner legally.

### 17. Crypto donation addresses in config are a supply-chain risk

Addresses in an environment variable can be silently redirected by a compromised
deploy environment. Consider committing the addresses to the repo (version-
controlled, publicly auditable) and only making the PayPal link configurable.

### 18. `crypto.randomUUID()` entropy — document it explicitly

The plan says "GUID alone" is the session secret. `crypto.randomUUID()` has 122
bits of entropy (6 fixed version/variant bits). That is fine, but explicitly
document it so no one replaces it with a shorter random string later.

---

## Missing Pieces (not in the plan at all)

| Gap | Why it matters |
|---|---|
| **Health check endpoint** | Without a health check, a dead runner gets sessions that immediately fail. How does the pool manager know a runner is alive before assigning it? |
| **Graceful shutdown** | `compose pull && up` kills active exports mid-stream. What happens to in-progress exports during a deploy? |
| **Log retention policy** | `ONENOTE_EXPORT_LOG_DIR=/data/logs` — how large can these grow? Are they rotated? Who reads them? |
| **Notebook size limit** | A user with 50,000 notes can fill the disk. The plan mentions per-session quota but does not specify a value or enforcement mechanism. |
| **Multi-tab behaviour** | Two tabs on the same GUID URL see two independent SSE streams. What if both click Export? (Related to point 6.) |
| **CORS policy** | If anything ever calls the runner sidecar directly from the browser, CORS must be locked to the app origin. Not mentioned. |
| **Content-Security-Policy** | Even without third-party JS, a CSP header is a cheap defence against injection from notebook content that reaches the UI as log lines. |

---

## Summary Table

| Severity | Count | Key items |
|---|---|---|
| 🔴 High | 5 | Caddy log risk, GUID exposure vectors, slot claim race, MFA timeout UX, zip served through app |
| 🟡 Medium | 7 | Export concurrency, SSE replay, non-atomic erase, rate limit gaps, token expiry, clock sync, Playwright tmpfs |
| 🟢 Low | 6 | Diagram gap, `listNotebooks` signal blocker, React CDN risk, ToS checkbox, donate addresses, UUID entropy doc |
| ❌ Missing | 7 | Health check, graceful shutdown, log retention, notebook size limit, multi-tab, CORS, CSP |

The plan is solid. Address the 🔴 items before writing any code. The 🟡 items
should be resolved before the §7.5 "Caddy + compose + CI" step. The rest can
follow naturally.
