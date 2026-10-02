# Architecture & Engineering Review: microsoft-onenote-exporter-web

> **Reviewer**: Gemini 3.8 Flash (High)  
> **Target Document**: [`PLAN.md`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-onenote-exporter-web/PLAN.md)  
> **Date**: October 2, 2026  
> **Repository**: `microsoft-onenote-exporter-web` & the `@msout` package ecosystem  

---

## Executive Summary

`PLAN.md` demonstrates strong design instincts: it embraces a radically privacy-first ethos (anonymous GUID sessions, zero credential persistence in databases, ephemeral per-session container isolation, and explicit threat modeling). The work sequencing (§7) wisely prioritizes upstream package updates and sidecar verification before tackling front-end polish.

However, a rigorous technical review against the underlying codebase ([`@msout/microsoft-webauth`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-webauth), [`@msout/microsoft-onenote-export-notebook`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-onenote-export-notebook), and [`@msout/microsoft-onenote-list-notebooks`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-onenote-list-notebooks)) reveals several **critical architectural contradictions, protocol misunderstandings (notably around Microsoft MFA and session token lifecycles), severe Denial of Service (DoS) attack vectors, and missing operational glue**.

If implemented as currently written, the service will face immediate operational failures:
1. **Microsoft Authenticator Number-Matching MFA will hang indefinitely** because the plan hallucinates an in-browser "Accept" button that does not exist in Microsoft's web flow.
2. **The credential proxying route through Caddy is technically impossible** as described without an unspecified dynamic routing mechanism.
3. **The service can be globally paralyzed in under 5 seconds** due to the rigid 12-hour slot lock policy.
4. **Exports triggered after ~1 hour will fail** because `auth.json` cookie expiry is ignored.
5. **Runner containers will crash on large notebooks** due to missing Chromium shared memory (`--shm-size`) and zombie process reaping (`--init`).

Below is the exhaustive, categorized critique with concrete engineering remedies.

---

## 1. 🔴 Critical Showstoppers & Fatal Misunderstandings

### 1.1 The "Number Match" MFA Illusion & WebAuth Protocol Error (§5, §6)

#### The Flaw
In §5, the plan defines the MFA challenge interface as:
```ts
type Challenge =
  | { kind: 'code'; label: string }              // OTC / SMS / authenticator
  | { kind: 'number-match'; numbers: [number, number] }
```
And states:
> *"The UI resolves with the code string, or with `'approve'` for number-match, and the sidecar taps **Accept** in the page."*

This is **factually incorrect** and demonstrates a fundamental misunderstanding of Microsoft's Number-Matching MFA:
1. **Payload Shape**: Microsoft does *not* display a tuple of two numbers (`numbers: [number, number]`). It displays a **single 2-digit number** (e.g., `42` or `87`) on the web page. The user is prompted on their phone: *"Enter the number shown on your computer screen"*.
2. **Missing In-Browser Button**: The browser has **no "Accept" button** during number-matching! In [`microsoft-webauth/src/auth.js`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-webauth/src/auth.js#L1459-L1483), the browser simply extracts `matchNumber` from `.displaySign`, displays it, and waits via `Promise.race`:
   ```js
   await Promise.race([
       page.waitForSelector(NUMBER_MATCH, { state: 'hidden', timeout: 120000 }),
       page.waitForURL(url => !url.toString().includes('login.microsoftonline.com'), { timeout: 120000 }),
       page.waitForSelector('text=/Stay signed in/i', { timeout: 120000 }),
   ]);
   ```
   The user approves on their physical mobile device. The browser is completely passive.
3. **The Consequence**: If the sidecar waits for the user to send an `'approve'` command from the web UI to "tap Accept in the page", the sidecar will search for a non-existent button, fail or time out, and abort the login.

#### The Fix
- Redefine the `Challenge` payload:
  ```ts
  export type Challenge =
    | { kind: 'code'; label: string; timeoutMs: number }
    | { kind: 'number-match'; code: string; timeoutMs: number };
  ```
- For `number-match`, emit the code over SSE to the browser for visual display only. The sidecar should simply await the Playwright navigation/settlement. The web UI needs to render:
  > *"Open Microsoft Authenticator on your mobile device and enter **[ 42 ]**."*
  No user action button should be rendered on the web page other than a "Cancel Login" button.

---

### 1.2 The Caddy Dynamic Routing Fantasy (§1, §3)

#### The Flaw
The plan states:
> *"The password must **bypass the app entirely**. Caddy routes `POST /s/:guid/cred` straight to the runner, not through the Fastify router."*

However, consider the deployment reality:
- There are 12 dynamic runner containers (`runner-1` through `runner-12`).
- A GUID is assigned dynamically to an idle runner when a user enters the site.
- **Caddy has no native knowledge of which GUID maps to which runner IP/port.**
- Standard Caddy configuration (`Caddyfile`) is static. Caddy cannot inspect a path parameter (`:guid`), query an external SQLite database or Docker labels on the fly, and dynamically proxy the request to `http://runner-7:3000/login` without either:
  1. A custom compiled Caddy Go plugin with dynamic upstreams.
  2. Dynamically re-writing and reloading Caddy's configuration via Caddy's Admin API (`POST /load`) every time a session is created or destroyed (which is slow, race-condition prone, and fragile).
  3. Reverse proxying through an internal gateway.

Furthermore, Caddy is already an HTTP reverse proxy written in Go: **the password bytes pass through Caddy's memory buffer anyway**. Claiming that Fastify touching the bytes violates privacy while Caddy touching the bytes does not is a false sense of security.

#### The Fix
Choose one of two robust patterns:
1. **Transparent Fastify Stream Forwarding (Recommended)**:
   - Route `POST /session/:guid/login` to the main Fastify server.
   - Fastify looks up the runner container IP from SQLite in 0.5 ms.
   - Fastify streams the HTTP request body directly to `http://<runner-ip>:3000/login` via `undici` or `fastify-http-proxy` without parsing JSON, without accumulating the body into an application object, and with `bodyLimit` enforced.
   - Ensure Fastify's logger has `redact: ['req.headers.authorization', 'req.body.password']` and request-body logging is disabled globally.
2. **Fixed Subdomain / Port Mapping**:
   - If Caddy *must* route directly, allocate deterministic session ports or URLs (e.g. `POST /slot-1/cred`), but this exposes internal container slot numbers to the client and requires pre-allocating static upstreams in Caddy. Transparent Fastify stream forwarding is far cleaner and achieves the same zero-persistence guarantee.

---

### 1.3 Blind 12-Hour Trust in `auth.json` vs Token Expiry (§1, §2, §6)

#### The Flaw
Table 1 states:
> *"Auth validity: `auth.json` existence is trusted for the life of the session."*
And §6 mentions:
> *"List notebooks — greyed out until `auth.json` exists."*  
> *"Export one notebook — greyed out until `auth.json` exists."*

In reality:
- `auth.json` contains Playwright cookies and browser storage state captured at the moment of login.
- Microsoft session cookies (`ESTSAUTH`, SharePoint federated tokens, OAuth access tokens) have strict lifespans and frequently require renewal within **1 to 2 hours**.
- If a user claims a slot at 09:00, logs in, steps away for lunch, and clicks "Extract notebook" at 11:30, `auth.json` exists on disk, but the underlying tokens are expired.
- When `microsoft-onenote-export-notebook` attempts to load SharePoint/OneNote with stale credentials, Microsoft redirects to `login.live.com` or `login.microsoftonline.com`.
- The export will immediately crash with a cryptic timeout or selector error because `export-notebook` has no mechanism to prompt for re-authentication.
- In fact, [`microsoft-webauth/src/auth.js`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-webauth/src/auth.js#L1616-L1620) explicitly contains logic in `checkAuth()` that checks for this and deletes stale `auth.json` files when Microsoft redirects back to the login page!

#### The Fix
1. **Active Pre-Flight Check**:
   Before initiating an export, the runner sidecar must invoke `checkAuth()` (or execute a lightweight check against the OneNote endpoint).
2. **Session Expired Event**:
   If the session cookies have expired mid-session:
   - Emit an `auth_expired` SSE event.
   - Invalidate `auth.json`.
   - Update UI state to prompt the user to re-enter their credentials without destroying their existing exported files or GUID.

---

### 1.4 Global Denial of Service via Rigid 12-Hour Slot Lock (§2, §10)

#### The Flaw
§2 acknowledges:
> *"A user who authenticates once and disappears holds a slot for 12 hours. Twelve such users lock out the service for 12 hours. This was a deliberate choice ('slot = GUID session'), and it is the right default..."*

**This is not the right default; it is a critical vulnerability.**
- A script running 12 HTTP requests from a residential IPv6 block, Tor exit nodes, or a simple curl loop can allocate all 12 slots in under 5 seconds.
- The entire service worldwide is then rendered completely unavailable for 12 continuous hours.
- With 12 slots locked for 12 hours, the maximum possible throughput of the service is **24 users per day**, on a 48 GB RAM dedicated host!
- Real users who complete an export in 10 minutes and download their zip will hold their container captive for the next 11 hours and 50 minutes doing absolutely nothing.

#### The Fix
Decouple **Session Lifetime (Data Retention)** from **Container Execution Lifetime**:
1. **Session Data Lives 12h**: The exported zip file and metadata remain accessible for 12 hours via static storage.
2. **Idle Container Release (TTL)**:
   - If a runner container has been idle (no login in progress, no export running) for **20 minutes**, the container is reclaimed.
   - If an export completes, the artifact is saved to the session directory, and the container is recycled back to the idle pool.
3. If an unauthenticated GUID is generated but no login is attempted within **10 minutes**, the slot is automatically released.

---

## 2. 🟡 High-Risk Engineering & Operational Gaps

### 2.1 The Missing Container Hardening Flags: `--shm-size` and `--init` (§4)

#### The Flaw
§4 lists the container runtime configuration:
```
--read-only
--cap-drop=ALL
--security-opt=no-new-privileges
--pids-limit=<n>
--memory=2g
--cpus=2
--network=<session-network>
--user=node
```
Notice what is missing:
1. **Missing `--shm-size=1g`**:
   Docker's default shared memory `/dev/shm` is only **64 MB**. Chromium requires significant shared memory to render complex web canvases, large SVG diagrams, and high-resolution printout images from OneNote.
   In [`microsoft-onenote-export-notebook/start-container.sh`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-onenote-export-notebook/start-container.sh#L67), this was explicitly highlighted:
   > *"Chromium needs more than Docker's default 64 MB of shared memory or it crashes on memory-heavy pages, hence `--shm-size=1g`."*
   Omitting `--shm-size` will cause Playwright Chromium to crash with `Target closed` or `SIGBUS` errors on large notebooks.
2. **Missing `--init` (PID 1 Reaper)**:
   Chromium launches zygote processes, renderers, utility sub-processes, and GPU helpers. When Node.js runs as PID 1 inside a Docker container, it does not reap zombie processes. Over a prolonged export or repeated Playwright browser launches, zombie processes accumulate until `--pids-limit` is reached, crashing the container.
3. **`--read-only` Rootfs vs Playwright Cache**:
   Chromium and Playwright require writable paths:
   - `/tmp`
   - `/home/node/.cache` (Chromium user data, fonts, GPU cache)
   - `/data/logs`
   If `--read-only` is set without mounting writable `tmpfs` volumes at these specific paths with `node:node` ownership, Chromium will fail to start immediately.

#### The Fix
Update the runner container flags in the specification:
```bash
--init \
--shm-size=1g \
--read-only \
--tmpfs /tmp:rw,noexec,nosuid,size=512m \
--tmpfs /home/node/.cache:rw,noexec,nosuid,size=512m \
--tmpfs /app/logs:rw,noexec,nosuid,size=256m \
-v /srv/msout/sessions/${GUID}/output:/data/output:rw \
--cap-drop=ALL \
--security-opt=no-new-privileges \
--pids-limit=200 \
--memory=2.5g \
--cpus=2 \
--user=node
```

---

### 2.2 Chromium Sandbox inside Docker vs `--cap-drop=ALL` (§4)

#### The Flaw
§4 emphasizes enabling Chromium's native sandbox and not using `--no-sandbox`:
> *"enable unprivileged user namespaces on the host... and let Chromium's own sandbox operate. This is the single most important security decision in the project..."*

While the security philosophy is commendable, getting Chromium's sandbox to work inside Docker when combined with `--cap-drop=ALL` and `--security-opt=no-new-privileges` is notoriously tricky:
- Chromium's sandbox requires unprivileged user namespaces (`clone(CLONE_NEWUSER)`).
- Default Docker seccomp profiles historically block `clone(CLONE_NEWUSER)` or certain `unshare` syscalls.
- If Docker's default seccomp profile or capability dropping interferes with namespace creation, Chromium will crash on launch with:
  `[FATAL:zygote_host_impl_linux.cc] Failed to move to new namespace: Operation not permitted`.
- Testing this only in local macOS Docker Desktop (which runs a custom VM) will pass, but running it on a Linux production host with AppArmor/Seccomp enabled will fail.

#### The Fix
- The project must define an explicit Seccomp profile or verify the exact flags required on the host Linux kernel (Ubuntu 24.04 / Debian 12) during Step 2 of the work sequence.
- An automated CI test must assert container startup under the exact production Docker flags to verify that Chromium initializes successfully without `--no-sandbox`.

---

### 2.3 Single Source of Truth: Race Conditions in Slot Allocation (§2)

#### The Flaw
§2 states:
> *"The GUID → runner mapping is recorded as Docker labels... The registry is therefore rebuilt from `docker ps` on boot... A small SQLite file mirrors the same data for fast point lookups..."*

Dual-state models (Docker labels + SQLite) create severe concurrency problems:
- `docker ps` and `docker update` are slow (50–200 ms) and not atomic.
- If two users request a session simultaneously, querying Docker labels will result in a race condition where both requests are assigned the same idle runner container.
- If the application crashes during label update, SQLite and Docker labels will fall out of sync.

#### The Fix
- **SQLite MUST be the single authoritative state engine**:
  Use atomic transactions:
  ```sql
  BEGIN IMMEDIATE;
  UPDATE runners 
  SET guid = ?, status = 'claimed', claimed_at = CURRENT_TIMESTAMP, expires_at = ?
  WHERE id = (
      SELECT id FROM runners WHERE status = 'idle' LIMIT 1
  );
  COMMIT;
  ```
  This guarantees zero race conditions and sub-millisecond slot assignment.
- Docker labels should only be used as metadata tags for manual sysadmin inspection or crash recovery, never as the live lock manager.

---

### 2.4 Serving Multi-Gigabyte Zip Downloads through Fastify (§3, §6)

#### The Flaw
§3 routes artifact downloads through the application:
`Fastify -> /files/* or runner -> GET /artifacts/:id.zip`.

OneNote notebooks containing embedded PDFs, high-res photos, and media attachments frequently reach **2 GB to 10 GB+**.
Proxying gigabytes of zip data from the runner through Fastify to Caddy and then to the browser:
- Consumes Node.js event loop cycles and network buffers.
- Ties up runner container connections during slow client downloads.
- Exposes Fastify to backpressure and memory leaks.

#### The Fix
- When the runner finishes zipping the output directory, it places `export.zip` in the host-mounted session volume: `/data/sessions/<guid>/export.zip`.
- Fastify or Caddy can serve this file directly.
- Better yet, configure Caddy with `file_server` to serve `/session/:guid/download` directly from the host filesystem using kernel `sendfile(2)` zero-copy transfers and full HTTP `Range` support, bypassing both Node.js and container processes.

---

### 2.5 SSE Connection Resiliency & Heartbeats (§1, §3, §6)

#### The Flaw
The plan relies on SSE for:
1. MFA challenge presentation.
2. Live export log streaming.
3. Completion notification.

However, the plan specifies no event buffering or replay strategy:
- Notebook exports take between **10 to 45 minutes**.
- Mobile browsers background tabs, Wi-Fi drops momentarily, and proxy connections time out.
- By default, Caddy, Cloudflare, and corporate firewalls kill idle HTTP/SSE connections after **60 seconds** of silence.
- If an SSE connection drops:
  - If the user misses the MFA challenge event, they are permanently stuck.
  - If the user misses the `done` event, the progress bar remains stuck at 99%.

#### The Fix
1. **Periodic Keepalive**: The SSE stream must emit a comment ping (`: keepalive\n\n`) every 15 seconds to prevent intermediate proxy timeouts.
2. **Event Buffering & Replay**:
   - The runner sidecar must maintain an in-memory ring buffer (e.g., the last 150 events).
   - Support `Last-Event-ID` header so reconnecting browsers automatically catch up on missed logs and state transitions without restarting the export.

---

## 3. 🟡 Security & Threat Model Refinements

### 3.1 GUID-in-URL Vulnerability vs v2 Deferral (§1, §6, §11)

#### The Flaw
§1 and §11 defer `GUID + 256-bit secret` to v2, relying solely on GUID-in-URL in v1:
> *"Today the URL is the credential, which is why the no-referrer and no-store headers are load-bearing rather than hygiene."*

Relying on GUID in the URL path (`/session/:guid`) exposes the user's active session to:
1. **Browser History & Sync**: Chrome, Edge, and Firefox sync browsing history across personal and corporate devices.
2. **Corporate TLS Inspection**: Many enterprise networks employ TLS-decrypting proxies that log full URL paths.
3. **Browser Extensions**: Extensions with `<all_urls>` permission can read the full address bar.
4. **Shoulder Surfing**: The raw GUID is visible in the URL bar.

#### The Fix (Trivial in v1)
Do not wait for v2:
- When a session is created, generate a random 256-bit session token.
- Set it as a `SameSite=Strict; HttpOnly; Secure` cookie scoped to `/session/`.
- Alternatively, put the token in the URL **hash fragment** (`https://service.example/session/:guid#key=<secret>`).
  - Hash fragments are **never transmitted to the server** in HTTP request headers.
  - Hash fragments are **never sent in `Referer` headers**.
  - Hash fragments are **never logged by Caddy or intermediate proxies**.
  The client-side React app extracts the key from `window.location.hash` and passes it in an `Authorization: Bearer <key>` header.

---

### 3.2 Microsoft Datacenter IP Throttling & CAPTCHA Wall (§10)

#### The Flaw
The plan mentions IP rate limits for abuse mitigation (§9), but overlooks the reverse problem: **Microsoft rate-limiting the VPS**.
- When multiple runner containers on a single VPS IP repeatedly automate logins to `login.live.com` or `login.microsoftonline.com`, Microsoft's anti-fraud heuristics flag the datacenter IP address.
- Microsoft frequently responds by injecting an **Arkose Labs FunCAPTCHA** ("Rotate the animal to face the direction of the hand") or blocking the IP entirely.
- [`microsoft-webauth`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-webauth) cannot solve CAPTCHAs and will fail with a selector timeout.

#### The Fix
1. **Explicit Detection**: Update `microsoft-webauth` to detect CAPTCHA iframe selectors and emit an explicit error code (`error: 'captcha_required'`) rather than burning a 60-second timeout.
2. **Honest User Messaging**: If Microsoft demands a CAPTCHA, inform the user clearly:
   > *"Microsoft has flagged this server's IP address with a visual CAPTCHA challenge. Please try again later or export using the local CLI tool."*
3. **Egress IP Rotation / Residential Proxy Hook**: Design the runner network configuration so that an HTTP/SOCKS5 proxy can be injected via environment variables (`HTTPS_PROXY`) if proxy routing is required later.

---

### 3.3 Disk Quota & Zip Bomb Mitigation (§9, §10)

#### The Flaw
The security checklist (§9) mentions:
> *"Disk-full behaviour: export fails cleanly, partial kept, session survives."*

If 12 users simultaneously export large OneNote notebooks containing dozens of embedded videos or printouts:
- 12 uncompressed exports (~10 GB each) + 12 zip archives (~10 GB each) = **240 GB of disk consumption**.
- On a 48 GB RAM VPS, disk space can easily be exhausted, impacting the host OS, Docker daemon, and SQLite database.

#### The Fix
1. **Per-Session Storage Quota**: Limit the session output folder to **10 GB** (enforced via Docker volume quota, `tmpfs` size limit, or periodic disk usage checks during `downloadResource`).
2. **Direct Streaming to Zip**: Instead of dumping all files to disk and then invoking `zip -r` (which requires 2x the disk space: uncompressed + archive), stream files into the zip archive on the fly using `archiver` or `zipstream`, reducing the disk footprint by 50%.
3. **Host Disk Guard**: Fastify should monitor host available disk space. If free disk space drops below **15%**, reject new export requests with HTTP 507 (Insufficient Storage).

---

## 4. 🟡 Codebase Inconsistencies & Package Upgrade Details

### 4.1 Error Handling in `microsoft-webauth` (`src/auth.js`)

In [`microsoft-webauth/src/auth.js`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-webauth/src/auth.js#L1575-L1580), the current `login()` function catches errors and swallows them:
```js
} catch (error) {
    logger.error('Authentication failed or cancelled:', error);
    if (isAutomated) {
        logger.debug('Possible cause: incorrect credentials, MFA requirement, or selector change.');
    }
} finally {
    await browser.close();
}
```
Because it does not re-throw, `await login(credentials)` currently **resolves successfully (to `undefined`) even when authentication fails**.
When upgrading `microsoft-webauth` to `0.2.0` (§5), `login()` **must re-throw structured errors** (or return `{ success: false, error: ... }`) so the sidecar can return proper HTTP 401/403/500 status codes.

---

### 4.2 Parameter Discrepancy in `microsoft-onenote-export-notebook`

The plan (§5) proposes:
```ts
runExport({
  authFile, notebook | notebookLink, outputDir,
  signal?,
  onEvent?,
})
```
However, inspecting [`microsoft-onenote-export-notebook/src/exporter.js`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-onenote-export-notebook/src/exporter.js#L1140-L1143):
- The existing function expects `{ contentFrame, notebookName, options }` and options takes `options.exportDir` or `options.outputDir`.
- The CLI (`src/index.js`) maps `--output-dir` to `options.outputDir`.
Ensure that the updated `runExport` in `0.4.0` standardizes on `outputDir` and normalizes options cleanly.

---

### 4.3 Missing `signal` in `microsoft-onenote-list-notebooks`

§5 mentions:
> *"Likely no changes. Confirm whether it accepts a signal if cancel-on-navigation is wanted; if not, add it."*

In [`microsoft-onenote-list-notebooks/src/list-notebooks.js`](file:///Users/enola/Workspace-msout/microsoft-onenote-exporter-rationnalize/microsoft-onenote-list-notebooks/src/list-notebooks.js#L75-L105):
- `listNotebooks()` has a **45-second `networkidle` timeout** and **30-second navigation timeouts**.
- It does **not** accept an `AbortSignal`.
- If a user cancels or disconnects while notebooks are being listed, Playwright will stay active for up to 75 seconds.
- **Verdict**: Adding `signal?: AbortSignal` to `listNotebooks` is mandatory, not optional.

---

## 5. Architectural & Design Recommendations

### Recommended Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│                        Browser                         │
└──────────────┬───────────────────────────┬─────────────┘
               │                           │
   Static UI / Assets             Direct Zip Download
   (Fastify / Caddy)            (Caddy file_server Range)
               │                           │
┌──────────────▼───────────────────────────▼─────────────┐
│                    Caddy Reverse Proxy                 │
│         (TLS termination, HSTS, no-referrer)           │
└──────────────┬─────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────┐
│               App Server (Fastify + TypeScript)        │
│  • SQLite Slot Engine (Atomic transactions)            │
│  • Session State & Quota Manager                       │
│  • Credential Stream Forwarder (Zero disk / heap leak) │
│  • SSE Broadcast & Log Replay Buffer                   │
└──────────────┬─────────────────────────────────────────┘
               │ Internal Docker Network
┌──────────────▼─────────────────────────────────────────┐
│              Runner Pool (Pre-warmed Containers)       │
│  runner-1        runner-2        …        runner-12    │
│  Sidecar API:                                          │
│   • POST /login (streams Playwright MFA challenges)    │
│   • POST /export (AbortSignal + progress events)       │
│   • Output written to host-mounted session volume      │
└────────────────────────────────────────────────────────┘
```

---

## 6. Summary Comparison Table: Current Plan vs Recommended Plan

| Component / Area | `PLAN.md` Current State | Recommended Improvement |
|---|---|---|
| **MFA Number Match** | Expects `[number, number]` & simulated click on "Accept" | Displays single number to user; browser passively awaits mobile approval. |
| **Credential Proxy** | Assumes Caddy routes `/s/:guid/cred` directly to runner | Fastify transparently streams request to internal runner IP; zero body logging. |
| **Auth Trust** | Trusts `auth.json` blindly for 12 hours | Runs pre-flight auth check; emits `auth_expired` if cookies expire. |
| **Slot Hold Policy** | Fixed 12 hours per container (max 24 users/day) | 20-min idle TTL on container; 12h retention on exported zip files. |
| **Session Secret** | GUID alone in URL (postpones secret to v2) | URL hash fragment (`#key=...`) or `HttpOnly` cookie in v1. |
| **Docker Flags** | Missing `--shm-size` and `--init` | Add `--shm-size=1g`, `--init`, and explicit writable `tmpfs` mounts. |
| **Pool State** | Dual state: Docker labels + SQLite | SQLite as atomic source of truth; Docker labels for sysadmin inspection only. |
| **Artifact Delivery** | Proxied through Fastify streams | Direct static delivery via Caddy `file_server` with zero-copy `sendfile`. |
| **SSE Logs** | Unbuffered streaming | 15s keepalive ping + ring buffer with `Last-Event-ID` replay. |
| **`microsoft-webauth`** | Swallows errors and returns `undefined` | Re-throws structured errors with actionable error codes. |

---

## 7. Suggested Action Items for `PLAN.md`

1. **Update §1 & §2**: Replace the rigid "container = 12h slot" model with an **Idle Container TTL (20 min)** while retaining the **12h session artifact retention**.
2. **Correct §5**: Fix the `Challenge` type definition and remove the "sidecar taps Accept" instruction for number-matching MFA.
3. **Clarify §3**: Remove the claim that Caddy dynamically routes path-based GUIDs to internal container ports; specify Fastify stream-forwarding or explicit upstream discovery.
4. **Update §4**: Add `--shm-size=1g` and `--init` to the runtime hardening specification.
5. **Update §6**: Include `Last-Event-ID` support and keepalive pings in the SSE specification.
6. **Move GUID Secret from §11 (v2) to §1/§6 (v1)**: Use a client-side URL hash key (`#secret=...`) or `HttpOnly` cookie to prevent address-bar credential leakage.
