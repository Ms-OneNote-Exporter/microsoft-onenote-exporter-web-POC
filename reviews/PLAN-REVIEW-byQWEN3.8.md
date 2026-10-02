Here is the consolidated review content for `PLAN-REVIEW-byQWEN3.8.md`.

```markdown
# PLAN-REVIEW-byQWEN3.8.md

Consolidated implementation review of `PLAN.md` for `microsoft-onenote-exporter-web`.

Inputs consolidated:

- `PLAN.md`
- `PLAN-REVIEW-byQWEN3.7.md`
- `PLAN-REVIEW-byCLAUDE.md`
- `PLAN-REVIEW-byGEMINIFLASH3.8.md`

Reviewer role: expert JavaScript / Docker / web backend / frontend review.

---

## 1. Executive summary

`PLAN.md` is unusually thoughtful for a pre-implementation document. It has a clear privacy posture, an explicit threat model, honest tradeoffs, and a sensible high-level build order. The core idea — anonymous GUID sessions, disposable containers, no accounts, no persistent credential storage — is coherent.

However, the three independent reviews converge on the same conclusion:

> The plan is not safe to implement as written.

The most serious issues are not cosmetic. They involve credential exposure, session hijacking, trivial denial-of-service, incorrect Microsoft MFA behavior, container runtime failures, race conditions in slot allocation, unreliable SSE, and disk exhaustion during large exports.

The consolidated verdict is:

- **Do not begin full implementation of the current plan unchanged.**
- **Fix the P0 items below before writing production code.**
- **Fix P1 items before public launch.**
- **Treat several items currently deferred to v2 as v1 requirements**, especially:
  - a real session secret instead of raw GUID-in-URL,
  - idle/container TTL separation,
  - reliable SSE replay,
  - auth expiry handling,
  - corrected MFA semantics.

The most important architectural changes are:

1. **Decouple session data lifetime from runner container lifetime.**
   - Session artifacts may live for up to 12 hours.
   - Runner containers must not be held for 12 hours merely because a GUID exists.
   - Introduce idle TTL, post-export TTL, and unauthenticated TTL.

2. **Make SQLite the single live source of truth for session/slot state.**
   - Docker labels are acceptable for recovery and operator inspection.
   - Docker labels must not be the live locking mechanism.

3. **Stop treating the GUID in the URL as the sole credential.**
   - Move session authorization into an `HttpOnly`, `Secure`, `SameSite=Strict` cookie or equivalent signed token.
   - Keep the GUID as an identifier, not as the full secret.

4. **Correct the Microsoft MFA model.**
   - Number matching is not “tap Accept in the browser”.
   - The browser page is passive; the user approves in Microsoft Authenticator.
   - The UI should show the number, a countdown, and a cancel action.

5. **Make the credential path explicit and technically honest.**
   - Caddy cannot magically route arbitrary GUID paths to dynamic runners without extra machinery.
   - Either use a carefully implemented raw-stream proxy through Fastify with no logging/persistence, or implement application-layer encryption so intermediaries only see ciphertext.
   - The current claim “credentials never pass through application code” is not true under the described architecture.

6. **Make SSE reliable by design.**
   - Event IDs.
   - Ring buffer.
   - `Last-Event-ID` replay.
   - Keepalive pings.
   - Reconnection behavior.
   - State snapshot on reconnect.

7. **Avoid multi-gigabyte artifact proxying through Node.js.**
   - Prefer direct or authorized static serving from Caddy where possible.
   - Use streaming zip generation where feasible.
   - Enforce per-session quotas and host disk guards.

---

## 2. Consolidated severity model

This review uses the following priorities:

- **P0 — Blocking before code or early prototype.**
  The system is insecure, unreliable, or architecturally incorrect without these fixes.

- **P1 — Required before public launch.**
  The system may be prototypeable without them, but it should not be exposed publicly.

- **P2 — Recommended soon after launch.**
  Valuable operational, UX, or privacy improvements.

---

## 3. Cross-review consensus

The three reviews overlap heavily on the most important issues. Where they differ, this document makes a consolidated recommendation.

### Strong agreement across reviews

All three reviews identify major problems with:

1. **Credential routing through Caddy / app**
   - Qwen: Caddy touching plaintext password is fragile.
   - Claude: Caddy logging risk; enforcement required, not just wording.
   - Gemini: Caddy dynamic GUID-to-runner routing is not realistically specified.

2. **GUID-in-URL as sole credential**
   - Qwen: URLs leak via history, referrers, extensions, logs.
   - Claude: screenshots, history sync, extensions, shoulder surfing.
   - Gemini: same; recommends moving secret out of URL into cookie/hash.

3. **Fixed 12-hour container hold is a denial-of-service vector**
   - Qwen: trivially DDoSable; idle TTL required in v1.
   - Claude: 12 careless users lock service for 12 hours.
   - Gemini: attacker can allocate all slots in seconds; max throughput absurdly low.

4. **SSE must support reconnection and replay**
   - Qwen: `Last-Event-ID`, circular buffer.
   - Claude: specify buffer strategy and reconnection.
   - Gemini: keepalives, ring buffer, mobile/proxy timeouts.

5. **Zip/artifact handling can exhaust disk or memory**
   - Qwen: streaming zip instead of system `zip`.
   - Claude: do not serve multi-GB zip through app.
   - Gemini: direct Caddy static serving, quotas, disk guards.

6. **Container hardening is incomplete**
   - Qwen: kernel namespace risk; memory watchdog.
   - Claude: read-only rootfs with Playwright is tricky.
   - Gemini: missing `--init`, `--shm-size`, tmpfs paths, sandbox verification.

7. **Microsoft auth validity is weaker than assumed**
   - Claude: tokens expire; 401s need handling.
   - Gemini: `auth.json` existence is not sufficient; preflight check required.
   - Qwen indirectly supports this through MFA brittleness and auth lifecycle concerns.

---

## 4. P0 blocking issues

These must be resolved before implementation proceeds seriously.

---

### 4.1 Credential path and privacy claim are architecturally unsound

#### Problem

`PLAN.md` says:

> Browser POSTs directly into the session container. Never through app-server memory.

It also says:

> Caddy routes `POST /s/:guid/cred` straight to the runner, not through the Fastify router.

The reviews identify three separate problems:

1. **Caddy cannot easily route dynamic GUID paths to dynamically assigned runner containers.**
   - There are 12 runners.
   - GUID-to-runner assignment happens at runtime.
   - A normal static Caddyfile cannot safely and atomically know which GUID maps to which runner.
   - Using the Caddy admin API to rewrite routes per session is fragile and race-prone.

2. **Caddy still touches request bytes as a proxy.**
   - Even if Caddy routes directly to the runner, Caddy is still in the request path.
   - If logging, debugging, buffering, or middleware is misconfigured, credentials may be exposed.

3. **The privacy claim is too strong.**
   - If the app or proxy handles plaintext HTTP bodies, saying “never seen by application code” is not technically defensible.
   - The plan must state what is enforced, not merely what is intended.

#### Consolidated recommendation

Choose one of two honest architectures.

##### Option A — Pragmatic v1: raw-stream Fastify forwarding

This is the simplest robust path.

- Browser sends credentials to Fastify.
- Fastify does **not parse** the JSON body.
- Fastify streams the request body directly to the assigned runner sidecar.
- Fastify enforces:
  - strict maximum body size,
  - request timeout,
  - no body logging,
  - redacted headers,
  - no request body accumulation.
- Runner sidecar parses the credential payload inside the isolated container.

Implementation notes:

- Use a streaming HTTP client such as `undici`.
- Do not attach a JSON body parser to the credential route.
- Check `Content-Length` before proxying.
- Destroy the stream if body exceeds limit.
- Disable request body logging globally.
- Add CI assertions that body logging is disabled.
- Add explicit comments in Caddyfile and Fastify code that credential routes must never log bodies.

Revised privacy wording:

> Credentials are transmitted over TLS and are proxied to the isolated session runner without parsing, logging, or persistence by the application server. Only the runner container processes the credential.

This is less absolute than the original claim, but it is implementable and honest.

##### Option B — Stronger privacy: browser-side encryption to the runner

If “intermediaries must not see plaintext” is a hard requirement, implement application-layer encryption.

Suggested design:

- When a session is bound to a runner, the runner sidecar generates an ephemeral keypair.
- The runner exposes a public key.
- The browser encrypts the credential payload using WebCrypto.
  - For example: ECDH P-256 key agreement + AES-GCM content encryption.
- The app and Caddy only see ciphertext.
- The runner sidecar decrypts the payload locally.

Important caveat:

- The app still mediates key discovery.
- A malicious or compromised app could theoretically substitute keys.
- This protects against passive logging, proxy inspection, and accidental exposure much better than plaintext proxying.
- It is not a full replacement for a trusted end-to-end channel with externally verifiable keys.

#### Required plan change

Replace the current credential path section with one of the above options.

Do not keep the sentence:

> Caddy routes `POST /s/:guid/cred` straight to the runner

unless the plan specifies a concrete dynamic routing mechanism and accepts the operational fragility.

Recommended consolidated choice:

> Use Option A for v1 unless the project’s privacy promise requires Option B. If Option A is chosen, update the privacy claim. If Option B is chosen, schedule it as a P0/P1 launch blocker, not as a vague future improvement.

---

### 4.2 GUID-in-URL must not be the sole credential

#### Problem

The plan uses `/session/:guid/*`, with the GUID as the only session secret in v1.

All reviews agree this is too weak.

Leak vectors include:

- Browser history.
- Synced history across devices.
- Screenshots and screen sharing.
- Shoulder surfing.
- Referrer headers, mitigated but not eliminated.
- Browser extensions with tab URL access.
- Corporate TLS inspection proxies.
- Support tickets and copy/paste accidents.
- Server/proxy access logs if routing is misconfigured.

A GUID has good entropy if generated with `crypto.randomUUID()`, but entropy alone does not make a URL safe as a credential. URLs are structurally leaky.

#### Consolidated recommendation

Move the credential out of the URL.

Preferred v1 design:

- Use the GUID as a public or semi-public session identifier.
- Generate a separate 256-bit session secret.
- Store the secret in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
- Serve the session UI from a generic path such as:
  - `/session`
  - `/session/dashboard`
  - `/s`
- Do not place the full credential in the URL path.

Example model:

```text
session_id = GUID
session_secret = random 256-bit token
cookie = signed_or_encrypted_token(session_id + session_secret)
```

The server stores:

```text
sessions(
  guid TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  runner_id TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
)
```

Important details:

- Hash the session secret server-side; do not store it in plaintext.
- Log only SHA-256 prefixes of GUIDs.
- Return `Cache-Control: no-store` on all session routes.
- Return `Referrer-Policy: no-referrer`.
- Require same-site/same-origin protections for mutating APIs.
- Add a CSRF defense if cookie-based state changes are used:
  - `SameSite=Strict` is a strong start.
  - Require a custom header such as `X-Requested-With` for state-changing APIs, or use a synchronizer token if needed.

If cross-device recovery is required:

- Do not put the secret in a normal URL query parameter.
- Consider a one-time recovery code shown to the user.
- If a URL-based mechanism is absolutely required, prefer a URL hash fragment:
  - `/session/:guid#key=...`
  - Hash fragments are not sent to the server or included in Referer headers.
  - The client extracts the key and sends it as an `Authorization` header.
- Still warn the user that anyone with the full URL including fragment can access the session.

#### Required plan change

Move “GUID + 256-bit secret” from v2 to v1.

The current v2 deferral is not acceptable for a public service handling Microsoft credentials.

---

### 4.3 Fixed 12-hour container hold is a self-inflicted DoS

#### Problem

The plan gives each GUID session a runner container for a fixed 12 hours.

The plan acknowledges:

> Twelve such users lock out the service for 12 hours.

The reviews agree this is not acceptable for v1.

Attack scenario:

- An attacker creates 12 sessions.
- Optionally authenticates or merely claims slots.
- Closes tabs.
- Service is unavailable for 12 hours.

Operational problem:

- A user who completes an export in 10 minutes needlessly occupies 1.5 GB RAM for 11 hours 50 minutes.
- Maximum throughput can become as low as around 24 users/day on a 48 GB host.

#### Consolidated recommendation

Decouple **session data retention** from **runner container lifetime**.

Recommended lifetimes:

| State | TTL |
|---|---:|
| GUID generated but no login started | 5–10 minutes |
| Login started but not completed | 10–15 minutes |
| Authenticated but idle | 20–30 minutes |
| Export running | no idle kill while active, but absolute cap applies |
| Export complete | destroy/recycle container after 5 minutes unless user clicks “Keep session” |
| Session data/artifact retention | up to 12 hours |
| Absolute maximum session age | 12 hours |

Key changes:

- Do not allocate a runner container merely because a GUID was generated.
- Create GUID/session metadata in SQLite first.
- Bind a runner only when login is requested or when the session becomes active.
- Reclaim idle containers automatically.
- If a session becomes active again, rebind a runner and remount the same session volume.
- Keep exported zip artifacts available after container recycle, served statically or through authorized download.

This preserves the user-facing idea of a 12-hour session while preventing trivial resource exhaustion.

#### Required plan change

Replace:

> A slot is a GUID session, held a fixed 12h.

With:

> A session’s data may be retained for up to 12 hours, but runner containers are assigned dynamically and reclaimed after inactivity or export completion.

Also add:

- Global cap on new sessions per hour.
- Cap on concurrent exports.
- Rate limits by IP and IP range.
- Optional privacy-preserving challenge before session creation.

---

### 4.4 Microsoft number-matching MFA is incorrectly modeled

#### Problem

`PLAN.md` describes number matching as:

> The UI resolves with the code string, or with `'approve'` for number-match, and the sidecar taps Accept in the page.

Gemini’s review identifies this as factually wrong.

Microsoft number matching generally works like this:

- The web login page displays a single 2-digit number.
- The user opens Microsoft Authenticator on their phone.
- The user enters or approves that number on the mobile device.
- The browser page is passive while waiting for the mobile approval.

There is not normally a web-page “Accept” button for the sidecar to click.

#### Consolidated recommendation

Correct the challenge model.

Use something like:

```ts
type Challenge =
  | {
      kind: 'code';
      label: string;
      timeoutMs: number;
    }
  | {
      kind: 'number-match';
      code: string;
      timeoutMs: number;
    };
```

Do not use:

```ts
{ kind: 'number-match'; numbers: [number, number] }
```

unless the actual Microsoft flow being automated demonstrably presents two numbers and requires a browser-side action.

UI behavior for number-match:

- Show the number prominently.
- Say: “Open Microsoft Authenticator and enter the number shown.”
- Show a countdown.
- Show a cancel login button.
- Do not show an “Approve” button unless actual testing proves one exists and is required.

Sidecar behavior:

- Emit a `challenge` event.
- Wait passively for login navigation/settlement.
- Emit:
  - `challenge-seen`
  - `challenge-expired`
  - `login-success`
  - `login-failed`
  - `login-cancelled`

Robustness:

- Use ARIA labels, text matching, and role-based selectors where possible.
- Avoid brittle CSS selectors tied to exact Microsoft markup.
- If the expected UI cannot be found, emit a structured error or manual challenge event instead of hanging silently.

#### Required plan change

Update `microsoft-webauth` API and frontend flow before implementation.

This is a blocker because the current design can cause logins to hang or fail in production.

---

### 4.5 `auth.json` existence is not a valid 12-hour trust anchor

#### Problem

The plan says:

> `auth.json` existence is trusted for the life of the session.

This is unsafe.

`auth.json` contains browser state and cookies captured at login time. Microsoft tokens and cookies can expire or be invalidated. A file existing on disk does not mean the session is still authorized.

Failure mode:

- User logs in at 10:00.
- User starts export at 12:30.
- Tokens have expired.
- Export fails with confusing selector/navigation errors.
- User does not know they need to re-authenticate.

#### Consolidated recommendation

Add active auth validation.

Runner sidecar should:

- Perform a lightweight auth check before:
  - listing notebooks,
  - starting export,
  - resuming a session after container rebind.
- Emit explicit states:
  - `auth-valid`
  - `auth-expired`
  - `auth-check-failed`
- Invalidate or mark stale `auth.json` if Microsoft redirects to login.
- Preserve exported artifacts if auth expires.

Frontend should:

- Show a clear “Microsoft session expired” message.
- Re-enable the authentication block.
- Not destroy existing export results unless the user erases the session.

If token refresh is possible in the future, design events for it, but do not assume it for v1.

#### Required plan change

Replace:

> `auth.json` existence is trusted for the life of the session.

With:

> `auth.json` is checked before protected operations. If Microsoft authentication has expired, the sidecar emits `auth-expired` and the UI prompts re-authentication.

---

### 4.6 Runner container hardening is incomplete

#### Problem

The plan’s container hardening is directionally good but incomplete.

Missing or under-specified items:

- `--init`
- `--shm-size`
- full list of writable paths under read-only rootfs
- Chromium sandbox verification under production kernel/seccomp/AppArmor settings
- memory watchdog
- behavior when unprivileged user namespaces are unavailable

Gemini’s review specifically notes:

- Chromium can crash with Docker default `/dev/shm` size.
- Node as PID 1 can fail to reap zombie Chromium processes.
- Playwright/Chromium require writable cache directories.

Qwen’s review notes:

- Host kernel support for unprivileged user namespaces is not stable across modern distributions.
- Chromium memory leaks can push RSS beyond container limits.

#### Consolidated recommendation

Update the runner runtime specification.

Minimum recommended flags:

```sh
docker run \
  --init \
  --shm-size=1g \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m,uid=1000,gid=1000 \
  --tmpfs /home/node/.cache:rw,noexec,nosuid,size=512m,uid=1000,gid=1000 \
  -v /srv/msout/sessions/<session-id>/data:/data:rw \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --memory=2560m \
  --memory-swap=2560m \
  --cpus=2 \
  --user=node \
  --network=<restricted-runner-network> \
  runner-image
```

Notes:

- `/data` should be the persistent session volume.
- `auth.json`, output files, logs, and zip artifacts should live under the session volume.
- Browser cache and scratch space can live on tmpfs.
- `--pids-limit` must be tested; Chromium may need more than very low values.
- `--memory` should be tested against real large notebooks; 2 GB may be too tight, 2.5 GB or 3 GB may be safer.

Chromium sandbox:

- Do not default to `--no-sandbox`.
- Verify Chromium sandbox works in the exact production environment.
- Document required host settings, for example:
  - `kernel.unprivileged_userns_clone=1` where applicable,
  - AppArmor/seccomp settings,
  - kernel version constraints.
- Add an automated integration test that:
  - launches the hardened container,
  - starts Playwright Chromium,
  - navigates to a local or harmless page,
  - verifies browser process startup,
  - exits cleanly.

Fallback:

If user namespaces cannot be safely enabled on the chosen host:

- Use `--no-sandbox` only as a documented fallback.
- Compensate with stricter isolation:
  - no Docker socket,
  - no host network,
  - no privileged mounts,
  - restricted egress if possible,
  - non-root user,
  - read-only rootfs,
  - tight memory and PID limits,
  - no access to internal management APIs.

Memory watchdog:

- Sidecar should monitor browser/node RSS.
- If memory exceeds a threshold, for example 1.8–2.2 GB depending on limit:
  - abort export gracefully,
  - mark artifact partial if needed,
  - restart browser/context or sidecar process,
  - emit a user-visible event.

#### Required plan change

Expand §4 from a short hardening list into a tested runtime contract.

Add:

- `--init`
- `--shm-size`
- explicit tmpfs mounts
- session volume mount
- sandbox verification test
- memory watchdog
- fallback policy

---

### 4.7 Slot allocation must be atomic; SQLite must be authoritative

#### Problem

The plan uses Docker labels as the source of truth and SQLite as a mirror.

The reviews identify race conditions:

- Two simultaneous session claims could receive the same runner.
- Docker label updates are slow and not transactional.
- App restart during label update can desynchronize SQLite and Docker.
- Rebuilding from `docker ps` is useful for recovery but not ideal as the live lock manager.

#### Consolidated recommendation

Make SQLite the authoritative live state engine.

Use WAL mode:

```sql
PRAGMA journal_mode = WAL;
```

Suggested tables:

```sql
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle','claimed','active','draining','dead')),
  health TEXT NOT NULL DEFAULT 'unknown',
  last_health_at INTEGER,
  session_guid TEXT
);

CREATE TABLE sessions (
  guid TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  runner_id TEXT,
  state TEXT NOT NULL,
  auth_state TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  idle_expires_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  notebook TEXT
);
```

Atomic claim example:

```sql
BEGIN IMMEDIATE;

UPDATE runners
SET
  status = 'claimed',
  session_guid = :guid
WHERE id = (
  SELECT id
  FROM runners
  WHERE status = 'idle'
  ORDER BY RANDOM()
  LIMIT 1
);

COMMIT;
```

Then verify `changes() > 0` before creating the session row.

Docker labels should still exist for recovery:

```text
msout.session.guid
msout.session.expires
msout.session.state
```

But they should be treated as:

- recovery metadata,
- operator inspection metadata,
- boot reconciliation metadata,

not as the primary runtime lock.

Health checks:

- Runner sidecar should expose `GET /healthz`.
- App should poll runner health.
- Unhealthy runners should be drained/replaced.
- Do not assign sessions to unhealthy runners.

Boot reconciliation:

- On boot, compare SQLite with Docker containers.
- Adopt live containers that match valid session labels.
- Destroy or quarantine unknown/orphaned containers.
- Sweep orphaned session directories.

#### Required plan change

Update §2 and §3:

- SQLite is authoritative.
- Docker labels are for recovery.
- Add health checks.
- Add boot reconciliation and orphan cleanup.

---

### 4.8 SSE must specify replay, buffering, keepalive, and reconnection

#### Problem

The plan mentions SSE but does not specify:

- exact event route,
- event IDs,
- replay behavior,
- buffer size,
- keepalive interval,
- behavior on mobile network drops,
- behavior when user refreshes,
- behavior when multiple tabs are open.

This matters because:

- Exports can take many minutes.
- MFA challenges are time-sensitive.
- Mobile networks drop connections.
- Proxies and firewalls kill idle connections.
- Users refresh pages.

#### Consolidated recommendation

Define an SSE contract.

Recommended route:

```text
GET /api/session/events
```

Session authentication should use the session cookie, not the GUID in the path.

Event IDs:

- Every event has a monotonically increasing ID.
- The server honors `Last-Event-ID`.

Example event types:

```text
session-status
auth-state
login-started
challenge
challenge-expired
login-success
login-failed
auth-expired
notebooks-listed
export-queued
export-started
export-progress
export-log
export-aborted
export-done
export-partial
error
keepalive
```

Keepalive:

- Emit an SSE comment every 10–20 seconds:

```text
: keepalive
```

Buffer:

- Keep a bounded ring buffer per session.
- Suggested:
  - last 250–1000 events,
  - or 1–5 MB max,
  - whichever is simpler.
- If `Last-Event-ID` is too old, send a `reset` or `snapshot` event with current state.

Reconnection behavior:

- Browser `EventSource` reconnects automatically.
- On reconnect:
  - replay buffered events after `Last-Event-ID` if available,
  - otherwise send current state snapshot.
- UI should show “reconnecting…” when stream is down.

Frontend refresh:

- On mount, frontend calls `GET /api/session/status`.
- Then connects to SSE.
- UI restores:
  - auth state,
  - notebook list,
  - active export,
  - progress,
  - download availability,
  - session expiry countdown.

Multi-tab behavior:

- Multiple tabs for the same session should receive the same SSE fan-out.
- Mutating actions must be server-authorized.
- If one tab starts an export, other tabs should see it.
- If one tab aborts, all tabs update.

#### Required plan change

Add an SSE section to `PLAN.md` with:

- route,
- event types,
- IDs,
- replay policy,
- buffer size,
- keepalive interval,
- reconnect UX,
- multi-tab behavior.

---

### 4.9 Export concurrency, abort, and queue semantics must be explicit

#### Problem

The plan says:

> ~8 concurrent exports, remainder queue in-session.

This is ambiguous.

Questions not answered:

- Can two tabs start two exports in the same session?
- What happens if a second `POST /export` arrives while one is running?
- Is export queued globally or only per session?
- What happens if the user refreshes during export?
- What happens if the container is idle-recycled during export?

#### Consolidated recommendation

Define explicit concurrency rules.

Per session:

- Only one active export per session at a time.
- A second export request returns `409 Conflict`.
- Frontend disables the export button while export is active.

Global:

- Maximum concurrent exports should be capped, for example 8.
- Additional requests should either:
  - queue with a visible position, or
  - return `429 Too Many Requests` with retry guidance.

For v1, simpler is better:

- One active export per session.
- Global max concurrent exports.
- If global capacity is full, return `429`.
- Do not build a complex global queue unless needed.

Abort:

- Abort must stop traversal.
- Keep already exported files.
- Mark artifact as partial.
- Emit `export-aborted` and/or `export-partial`.
- Offer download if partial artifact exists.

Refresh:

- Export continues server-side.
- Frontend reattaches to SSE and status.

#### Required plan change

Update concurrency decision from vague “queue in-session” to explicit server-enforced rules.

---

### 4.10 Zip generation and artifact download need a disk-safe design

#### Problem

The plan says:

> Zip built in-container, reusable link until session end.

Reviews identify multiple risks:

- If raw Markdown/images are written to disk first and then zipped, disk usage can double.
- Large OneNote notebooks can exhaust disk.
- Serving multi-GB zips through Fastify can waste memory and sockets.
- System `zip` may require more disk than streaming alternatives.
- Disk-full behavior needs to be precise.

#### Consolidated recommendation

Adopt a layered artifact strategy.

##### 1. Use streaming zip creation

Do not shell out to system `zip` if it requires a second full copy of the data.

Use a Node streaming zip library such as:

- `archiver`
- `yazl`
- or another maintained streaming zip writer

Ideally:

- Stream exported files into the zip as they are produced.
- If the exporter cannot stream directly yet, at least stream file reads into zip without creating a second full uncompressed copy beyond the raw export directory.

##### 2. Enforce storage quotas

Per session:

- Set a maximum output size, for example 5–10 GB depending on host disk.
- Abort cleanly if quota exceeded.
- Mark export partial.
- Show clear user-facing error.

Host level:

- Monitor free disk.
- If free disk drops below a threshold, reject new exports with `507 Insufficient Storage`.
- Do not let exports crash the Docker daemon or host.

##### 3. Serve artifacts directly where possible

Do not proxy multi-gigabyte downloads through Node.js if avoidable.

Recommended pattern:

- Export zip is written to a host-mounted session directory:

```text
/srv/msout/sessions/<session-guid>/export.zip
```

- Caddy serves files using `file_server`.
- Access is authorized first by the app.

Possible Caddy pattern:

```caddy
handle /files/* {
  forward_auth app:3000 {
    uri /internal/authorize-download
    copy_headers Cookie
  }

  file_server {
    root /srv/msout/sessions
  }
}
```

The exact Caddy configuration should be adapted to the deployment, but the principle is:

- App validates session cookie and ownership.
- Caddy serves the file with efficient `sendfile` and `Range` support.
- Node does not stream the whole artifact.

If direct static serving is not possible:

- Use Node’s `fs.createReadStream()` with proper `Range` support.
- Do not buffer the full file in memory.
- Still avoid this for very large artifacts if possible.

##### 4. Handle partial artifacts

If export is interrupted:

- Preserve exported files.
- If zip is incomplete, either:
  - finalize a partial zip if possible,
  - or expose raw files as a separate partial artifact.
- UI must label partial downloads clearly.

#### Required plan change

Replace “Zip built in-container” with a concrete artifact pipeline:

- streaming zip,
- quota,
- disk guard,
- direct/static authorized download,
- partial artifact handling.

---

## 5. P1 launch-blocking issues

These should be resolved before public launch.

---

### 5.1 Rate limiting and abuse controls are too coarse

#### Problem

The plan proposes:

> IP rate limits, no captcha.

Reviews note:

- IPv6 makes simple per-IP limiting weak.
- Residential proxies bypass IP limits.
- The service could be used for credential stuffing.
- Microsoft may flag datacenter IPs with CAPTCHA or throttling.
- A few IPs can fill all slots.

#### Consolidated recommendation

Use layered limits.

Session creation:

- Per IPv4 address.
- Per IPv6 subnet, at least /48; consider /32 depending on deployment.
- Global cap per hour regardless of IP diversity.
- Exponential backoff for repeated failures.

Suggested baseline:

- 3 sessions/hour per IPv4.
- 3–5 sessions/hour per IPv6 /48.
- 20–30 new sessions/hour globally.
- 5 exports/hour per session.
- 30–60 exports/hour globally.

These numbers should be tuned after observing real usage.

Additional protections:

- Delay failed Microsoft login attempts.
- Add temporary lockout after repeated credential failures.
- Do not log passwords or full GUIDs.
- Store only truncated/hashed IPs for rate limiting.
- Consider a privacy-preserving challenge before session creation:
  - Cloudflare Turnstile,
  - hCaptcha,
  - or a lightweight proof-of-work challenge.

If third-party JS is unacceptable:

- Use proof-of-work.
- Or require invite codes during early launch.
- Or keep the service semi-private.

Microsoft-side risk:

- Detect CAPTCHA or unusual login walls.
- Emit explicit `captcha-required` or `microsoft-blocked` events.
- Tell the user honestly:
  > Microsoft has challenged this server’s IP. Try again later or use the local CLI exporter.

#### Required plan change

Expand abuse section from “IP rate limits, no captcha” to a concrete multi-layer policy.

---

### 5.2 Erase must be transactional, recoverable from failure, and honestly described

#### Problem

The plan says erase removes container and deletes directory.

Reviews note:

- Container removal and directory deletion are two operations.
- If one fails, orphaned data may remain.
- `rm -rf` is not cryptographic erasure.
- Secure deletion on overlayfs/SSD is imperfect.

#### Consolidated recommendation

Define erase sequence.

Suggested sequence:

1. Mark session state as `erasing`.
2. Abort active login/export.
3. Stop or freeze runner activity.
4. Best-effort secure delete sensitive files:
   - `auth.json`
   - exported Markdown/images
   - zip artifact
   - logs
5. Delete session directory.
6. Remove/recycle container.
7. Delete or tombstone SQLite session row.
8. Reclaim runner slot.

If directory deletion fails:

- Mark session `erase_failed`.
- Keep a record for retry.
- Sweep periodically.
- Alert operator if repeated.

If container removal fails:

- Force remove.
- If still failing, mark runner unhealthy and quarantine.

Secure deletion:

- Use `shred -u`, `rm -P`, or equivalent on files where supported.
- Understand that CoW filesystems, SSD wear leveling, and overlayfs limit guarantees.
- Do not claim cryptographic erasure unless using LUKS or equivalent.

UI wording:

Use:

> We deleted everything this service stored for this session.

Avoid:

> Nothing remains anywhere.

#### Required plan change

Make erase a state machine with failure handling and orphan sweep.

---

### 5.3 Frontend must restore state after refresh and reconnect

#### Problem

Qwen’s review notes that if a user refreshes mid-export, the UI should restore state.

Claude’s review also emphasizes SSE reconnection and UI state.

#### Consolidated recommendation

Frontend must:

- Call `/api/session/status` on mount.
- Establish SSE after status.
- Restore:
  - auth state,
  - notebook list,
  - active export,
  - progress,
  - log tail,
  - download link,
  - session expiry.
- Show reconnection status if SSE drops.
- Disable actions that server state says are invalid.
- Not require the user to restart an export after a refresh.

Recommended status payload:

```json
{
  "session": {
    "state": "active",
    "expiresAt": "2026-10-02T18:00:00Z",
    "idleExpiresAt": "2026-10-02T13:30:00Z"
  },
  "auth": {
    "state": "valid",
    "lastCheckedAt": "2026-10-02T12:55:00Z"
  },
  "notebooks": {
    "state": "loaded",
    "items": ["Personal", "Work"]
  },
  "export": {
    "state": "running",
    "id": "export-123",
    "progress": {
      "pages": 120,
      "sections": 8,
      "assets": 340
    },
    "partial": false
  },
  "artifact": {
    "available": false,
    "partial": false
  }
}
```

Countdown:

- Server should return absolute expiry as ISO-8601.
- Client computes remaining time locally.
- Optionally include server time to calculate clock offset.

---

### 5.4 Content Security Policy, CORS, and XSS hygiene

#### Problem

Claude’s review notes CSP and CORS are missing.

This matters because:

- Notebook names, log lines, and Microsoft challenge labels may contain untrusted text.
- The service handles sensitive authentication flows.
- Third-party JS is forbidden, so CSP should be strict.

#### Consolidated recommendation

Add CSP:

```http
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

Adjust if React build requires inline styles or specific bundler output.

Rendering logs:

- Render log lines as text, not HTML.
- If using React, avoid `dangerouslySetInnerHTML`.
- Sanitize anything that can contain notebook names, section names, or Microsoft strings.

CORS:

- Runner sidecar should not be directly reachable from the browser.
- App APIs should be same-origin.
- If any cross-origin access is ever needed, restrict it explicitly.

Additional headers:

```http
Referrer-Policy: no-referrer
Cache-Control: no-store
X-Content-Type-Options: nosniff
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

Use HSTS on the public origin.

---

### 5.5 React must be self-hosted and supply-chain controlled

#### Problem

Claude notes that CDN-hosted React would contradict the no-third-party-JS claim.

#### Consolidated recommendation

- Bundle React into the app image.
- Serve all JS/CSS from the app/Caddy.
- Do not use CDN scripts.
- Lock dependency versions.
- Use lockfile in CI.
- Audit dependencies.
- Avoid analytics, telemetry, or remote fonts.

---

### 5.6 Microsoft ToS interstitial acceptance needs explicit consent UX

#### Problem

`microsoft-webauth` automatically accepts Microsoft Terms of Use and security-info interstitials.

The plan says the frontend must “say so plainly”.

Claude recommends an explicit checkbox.

#### Consolidated recommendation

Use a checkbox before password submission:

> I understand that this tool will automatically accept Microsoft’s Terms of Use and security prompts on my behalf during login.

Do not pre-check it if legal consent is required.

Also display:

- Credentials are sent to Microsoft.
- The service is unofficial.
- Microsoft may prompt for MFA.
- Microsoft may block automated/datacenter logins.

---

### 5.7 Operational gaps: health checks, deploys, logs, quotas

Claude’s review lists missing operational pieces. They should be added before launch.

#### Health check endpoint

Runner sidecar should expose:

```text
GET /healthz
```

It should report:

- sidecar alive,
- browser launch possible,
- disk writable,
- auth state,
- active jobs.

App should:

- poll health,
- remove unhealthy runners from pool,
- replace them,
- avoid assigning sessions to unhealthy runners.

#### Graceful shutdown and deployment

`docker compose pull && up` can kill active exports.

Required behavior:

- Deployment should enter drain mode.
- Refuse new sessions.
- Allow active exports to finish up to a timeout.
- If export cannot finish, notify users if possible.
- Preserve partial artifacts.
- Record session state for recovery.

For v1, at minimum:

- Document that deploys may interrupt active exports.
- Add a maintenance banner.
- Avoid deploying while active exports exist if operationally possible.

#### Log retention

Define:

- max log size per session,
- rotation policy,
- deletion on erase/expiry,
- no passwords,
- no full GUIDs,
- no full IPs beyond retention needed for rate limiting.

Suggested:

- 50 MB max logs per session.
- Rotate at 10 MB.
- Keep only 3 rotated files.
- Delete with session.

#### Notebook size limit

The plan mentions quota but not enforcement.

Add:

- per-session disk quota,
- maximum export artifact size,
- host free-space threshold,
- export abort when exceeded.

---

## 6. P2 recommended improvements

These are not launch blockers but are valuable.

---

### 6.1 Secure deletion improvements

For v1, best-effort file shredding plus honest wording is enough.

For stronger privacy:

- Use LUKS encrypted volumes per session or per host data partition.
- Erase by destroying encryption key.
- This provides much stronger cryptographic erase semantics.

This remains a good v2 item.

---

### 6.2 Donation configuration hardening

Claude notes that crypto addresses in environment variables are supply-chain mutable.

Recommendation:

- Commit donation addresses to the repository for auditability.
- If addresses must be configurable, version-control the default and document changes.
- Environment variables may override, but public deployments should pin/verify them.

---

### 6.3 UUID entropy documentation

`crypto.randomUUID()` provides UUIDv4 with 122 random bits.

That is acceptable for an identifier, but:

- Do not replace it with shorter random strings.
- Do not use it as the only secret if the GUID is exposed in URLs.
- Add a separate 256-bit secret for authorization.

Document this explicitly.

---

### 6.4 Architecture diagram should include SQLite

The current diagram omits SQLite.

Add it inside the app server box:

```text
app (Fastify, TypeScript)
  • pool + session registry
  • SQLite state store
  • SSE hub
  • credential stream forwarder
  • artifact authorization
```

---

## 7. Consolidated decisions on disputed or ambiguous points

### 7.1 Caddy direct credential route vs Fastify proxy vs encryption

Reviews differ:

- Qwen recommends runner-side TLS or asymmetric encryption.
- Claude emphasizes Caddy log risk and CI enforcement.
- Gemini says Caddy dynamic routing is unrealistic and recommends Fastify stream forwarding.

Consolidated decision:

1. **Do not rely on unspecified Caddy dynamic GUID routing.**
2. For v1, use **Fastify raw-stream forwarding** unless end-to-end privacy from the app/proxy is a hard product requirement.
3. If hard privacy is required, implement **browser-side encryption to the runner** before launch.
4. In all cases, update the privacy wording.

---

### 7.2 Cookie vs URL hash fragment for session secret

Reviews suggest both.

Consolidated decision:

- Prefer **HttpOnly Secure SameSite=Strict cookie** as the primary session credential.
- Use URL hash fragment only if shareable/recoverable URL is explicitly desired and the UX warnings are clear.
- Do not put the secret in query strings or server-visible URL paths.

---

### 7.3 Streaming zip vs direct artifact serving

These are not mutually exclusive.

Consolidated decision:

- Use streaming zip creation to reduce disk pressure.
- Serve completed artifacts directly through Caddy or another static file mechanism after authorization.
- Do not proxy large zips through Fastify unless no alternative exists.

---

### 7.4 Chromium sandbox vs host kernel restrictions

Reviews differ in emphasis:

- Qwen warns about host kernel namespace restrictions.
- Gemini warns about Docker flags/seccomp.
- Claude warns about read-only rootfs friction.

Consolidated decision:

- Make sandbox verification a first-class integration test.
- Pin and document host OS/kernel requirements.
- Have a documented fallback if user namespaces are unavailable.
- Do not silently fall back to `--no-sandbox` without compensating controls and explicit documentation.

---

## 8. Recommended target architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ Browser                                                      │
│  • React UI, self-hosted                                     │
│  • session cookie                                            │
│  • SSE client with reconnect                                 │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Caddy                                                        │
│  • TLS termination                                           │
│  • static assets                                             │
│  • no body logging                                           │
│  • forward_auth for protected file downloads                 │
│  • file_server for artifacts                                 │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ App server: Fastify + TypeScript                             │
│  • SQLite authoritative state                                │
│  • session auth cookie validation                            │
│  • pool manager                                              │
│  • idle TTL sweeper                                          │
│  • SSE hub with replay buffer                                │
│  • credential raw-stream forwarder or ciphertext forwarder   │
│  • artifact authorization                                    │
│  • Docker manager via restricted socket/proxy                │
└───────────────────────────────┬──────────────────────────────┘
                                │ internal Docker network
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Runner pool                                                  │
│  runner-1 ... runner-N                                       │
│  • Fastify sidecar                                           │
│  • @msout packages                                           │
│  • Playwright Chromium                                       │
│  • host-mounted session volume                               │
│  • health endpoint                                           │
│  • SSE events                                                │
│  • export abort                                              │
│  • streaming zip                                             │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. Section-by-section amendments to `PLAN.md`

### §1 Decisions

Change:

| Area | Original | Consolidated replacement |
|---|---|---|
| Credentials | Browser POSTs directly into runner, never through app | Either raw-stream proxy with no parsing/logging, or browser-side encryption. Privacy text must match implementation. |
| Session secret | GUID alone in v1 | GUID + 256-bit secret in v1, preferably cookie-based. |
| Pool semantics | Slot held fixed 12h | Session data may live 12h; runner containers use idle/post-export TTL. |
| Auth validity | `auth.json` existence trusted | Auth checked before protected operations; emit `auth-expired`. |
| Concurrency | Queue in-session | One active export per session; global cap; second request gets 409/429. |
| Download | Zip built in-container, reusable link | Streaming zip, quota, direct/static authorized download. |
| Abuse | IP rate limits, no captcha | Layered IP/subnet/global limits; consider challenge; detect Microsoft CAPTCHA. |
| Erase | Remove container + delete directory | Stateful erase with secure-delete best effort, orphan sweep, honest wording. |

---

### §2 Container pool

Add:

- SQLite is authoritative.
- Docker labels are recovery metadata.
- Health checks.
- Idle TTLs.
- Unauthenticated TTL.
- Post-export recycle.
- Container rebind with same session volume.
- Global session/export caps.

Remove:

- “A slot is a GUID session, held a fixed 12h.”

---

### §3 Architecture

Add:

- SQLite component.
- SSE hub.
- Credential forwarder or ciphertext forwarder.
- Artifact authorization.
- Direct file serving path.

Remove or qualify:

- “Caddy routes `POST /s/:guid/cred` straight to the runner” unless a concrete dynamic routing mechanism is specified.

---

### §4 Runner image

Add:

- `--init`
- `--shm-size=1g`
- tmpfs mounts
- session volume
- memory watchdog
- Chromium sandbox verification
- host OS/kernel documentation
- fallback policy

---

### §5 Package changes

#### `microsoft-webauth`

Required:

- Correct MFA challenge model.
- Number-match challenge contains one code, not two numbers.
- No fake “Accept” click for number-match.
- Structured errors.
- `signal` support.
- `onEvent` support.
- Timeout events.
- CAPTCHA/block detection if feasible.
- `login()` must not swallow errors and resolve successfully on failure.

Suggested event types:

```ts
type WebAuthEvent =
  | { type: 'progress'; message: string }
  | { type: 'challenge'; challenge: Challenge }
  | { type: 'challenge-expired' }
  | { type: 'captcha-required' }
  | { type: 'success' }
  | { type: 'failed'; code: string; message: string };
```

Suggested error codes:

```text
bad_credentials
mfa_timeout
mfa_rejected
captcha_required
account_locked
network_error
selector_changed
aborted
unknown
```

#### `microsoft-onenote-export-notebook`

Required:

- `signal` support.
- `onEvent` support.
- Standardize `outputDir`.
- Preserve partial output on abort.
- Emit counts for real progress bars.
- Emit disk/quota errors cleanly.

#### `microsoft-onenote-list-notebooks`

Required:

- Add `signal` support.
- Do not treat this as optional.
- If user cancels, listing should abort promptly.

---

### §6 Frontend

Add:

- Cookie-based session.
- Status polling on mount.
- SSE reconnect UI.
- MFA countdown.
- Number-match passive approval UI.
- Auth-expired state.
- Export-in-progress locking.
- Multi-tab state synchronization.
- CSP.
- Self-hosted React.
- ToS checkbox.
- ISO-8601 expiry handling.

---

### §7 Work sequence

Amend sequence:

1. Package changes with tests.
2. Runner sidecar + container hardening.
3. **Production-like Chromium sandbox integration test.**
4. SQLite pool manager and atomic slot claim.
5. Credential path implementation with no-log assertions.
6. SSE hub with replay.
7. Artifact pipeline with quota and direct download.
8. React UI.
9. Caddy/compose/CI.
10. Abuse/rate-limit hardening.
11. Erase/orphan sweep tests.

The original plan correctly says steps 1 and 2 carry risk, but the sandbox and state-machine work should be treated as equally risky.

---

### §9 Security checklist

Add:

```text
[ ] Session secret is not in URL path/query
[ ] Session cookie is HttpOnly, Secure, SameSite=Strict
[ ] SQLite slot claim is atomic
[ ] Runner health checks implemented
[ ] SSE keepalive and Last-Event-ID replay tested
[ ] MFA number-match UI is passive and shows countdown
[ ] Auth expiry detected before export/list
[ ] --init and --shm-size present
[ ] Chromium sandbox verified in production-like environment
[ ] Fallback sandbox policy documented
[ ] Memory watchdog implemented
[ ] Per-session disk quota enforced
[ ] Host free-space guard enforced
[ ] Artifact download supports Range
[ ] Large artifact download does not buffer in Node
[ ] Global session and export rate limits implemented
[ ] IPv6 subnet limiting implemented
[ ] CSP configured
[ ] CORS locked down
[ ] React is self-hosted
[ ] Erase failure/orphan sweep implemented
[ ] Graceful deploy/drain behavior documented
[ ] Log retention limits defined
[ ] No passwords in logs
[ ] No full GUIDs in logs
[ ] No full IPs in long-term logs
```

---

## 10. Recommended implementation acceptance tests

These should exist before public launch.

### 10.1 Slot allocation

- Two concurrent session claims never receive the same runner.
- Pool exhaustion returns correct countdown.
- Reboot recovers active sessions from Docker labels + SQLite reconciliation.
- Orphan containers are detected and cleaned.
- Orphan directories are detected and cleaned.

### 10.2 Credential path

- Credential route does not parse body in app.
- Oversized credential body is rejected.
- No password appears in:
  - Caddy access logs,
  - Caddy error logs,
  - Fastify logs,
  - runner logs,
  - host logs.
- GUIDs are logged only as hashed prefixes.

### 10.3 Session auth

- Accessing session APIs without cookie fails.
- Accessing with valid cookie succeeds.
- Session secret is not present in URL.
- Refreshing page restores UI state.
- Logging out clears auth state.
- Erasing removes data and invalidates cookie/session.

### 10.4 MFA

- Code challenge displays input.
- Number-match challenge displays single number.
- Number-match challenge does not render fake approve button.
- Challenge expiry is emitted.
- User cancellation aborts login cleanly.
- Failed login returns structured error.

### 10.5 Auth expiry

- Stale auth is detected before export.
- UI shows re-authentication prompt.
- Existing artifacts survive auth expiry.
- Re-login restores ability to export.

### 10.6 Export

- Export emits progress events with counts.
- Abort preserves partial output.
- Partial artifact is labeled partial.
- Second concurrent export returns 409.
- Global export cap enforced.
- Disk quota exceeded fails cleanly.
- Host low disk rejects new exports.

### 10.7 SSE

- Disconnect and reconnect replays missed events when possible.
- Old `Last-Event-ID` results in snapshot/reset.
- Keepalive prevents proxy timeout.
- Multiple tabs receive same events.
- Refresh during export restores progress.

### 10.8 Container runtime

- Chromium starts under production Docker flags.
- Sandbox status is verified.
- `/dev/shm` is sufficient.
- Zombie processes are reaped.
- Read-only rootfs does not break Playwright.
- Memory watchdog triggers before OOM where feasible.

### 10.9 Artifact download

- Download supports HTTP Range.
- Large download does not buffer whole file in Node.
- Unauthorized session cannot download another session’s artifact.
- Expired session cannot download artifact.
- Partial zip behavior is explicit.

---

## 11. Risks that remain even after fixes

Some risks cannot be fully eliminated.

### Microsoft automation risk

Microsoft may:

- change login UI,
- require CAPTCHA,
- block datacenter IPs,
- reject automated browser logins.

Mitigation:

- robust selectors,
- explicit error events,
- honest user messaging,
- rate limiting,
- optional local CLI fallback.

### OneNote content size risk

Large notebooks can still exceed reasonable resources.

Mitigation:

- quotas,
- partial exports,
- clear errors,
- disk guards.

### Browser sandbox risk

Chromium sandboxing in containers remains complex.

Mitigation:

- production-like tests,
- OS pinning,
- documented fallback,
- reduced capabilities.

### Anonymous session risk

No accounts means no recovery.

Mitigation:

- clear warnings,
- cookie persistence,
- optional recovery code if desired,
- honest support limits.

---

## 12. Final consolidated recommendation

The plan should not be implemented as written.

The strongest version of this service requires the following v1 changes:

1. **Replace GUID-only URL auth with GUID + 256-bit secret, preferably in an HttpOnly cookie.**
2. **Replace fixed 12-hour container holding with idle TTL and post-export recycling.**
3. **Make SQLite the authoritative slot/session store with atomic claims.**
4. **Correct the MFA model, especially number matching.**
5. **Add auth expiry checks instead of trusting `auth.json` existence.**
6. **Specify and implement SSE replay, event IDs, keepalive, and reconnect behavior.**
7. **Use a technically honest credential path: raw-stream proxy or browser-side encryption.**
8. **Harden runner containers with `--init`, `--shm-size`, writable tmpfs paths, and verified Chromium sandbox behavior.**
9. **Use streaming zip, quotas, and direct/static authorized artifact download.**
10. **Add operational basics: health checks, orphan sweep, log retention, graceful drain, CSP, CORS, and rate limits.**

If these changes are made, the project becomes much more defensible from a security, reliability, and operational standpoint.

If they are not made, the service is likely to suffer from:

- session hijacking,
- trivial DoS,
- failed MFA logins,
- failed large exports,
- disk exhaustion,
- container crashes,
- confusing auth expiry errors,
- and unreliable progress UX.

The plan’s foundations are good. The privacy intent is admirable. But the next revision of `PLAN.md` needs to be stricter about what is technically true and operationally enforceable.
```
