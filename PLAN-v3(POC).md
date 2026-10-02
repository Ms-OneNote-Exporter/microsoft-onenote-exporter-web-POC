# PLAN-v3 (POC) — microsoft-onenote-exporter-web

Intermediate plan between [`PLAN.md`](./PLAN.md) and [`PLAN-v2.md`](./PLAN-v2.md).

**Goal of this document:** the smallest service that runs the real workflow end to
end against the **published, unmodified** `@msout/*` packages, on a developer
machine or a box on the local network, in days rather than weeks.

**Hard constraint:** *no file in `microsoft-webauth`,
`microsoft-onenote-list-notebooks`, `microsoft-onenote-export-notebook` or
`microsoft-onenote-exporter` is modified, forked or vendored.* They are consumed
from npm at pinned versions, exactly as a user would install them.

Everything PLAN-v2 requires from §6 "Package changes" is therefore **out of
scope**, and §2 of this document states precisely what that costs and how each
capability is obtained instead — by driving the existing CLIs as subprocesses and
reading their log output. That substitution is the whole design of this POC.

---

## 0. What this POC is, and what it is not

| | PLAN-v2 (target) | PLAN-v3 POC (this) |
|---|---|---|
| Packages | Extended in place, versions bumped | **Consumed as published binaries, untouched** |
| Isolation | Pool of N runners, per-session claim, rebind | **One runner container, one job at a time** |
| Session state | SQLite (WAL), authoritative | **One `state.json` per session** |
| Edge | Caddy, TLS, HSTS | **None — localhost / local network, HTTP** |
| Frontend | React + TS, self-hosted | **React + TS, self-hosted (same)** |
| Abuse control | Layered IP / IPv6 / global limits | **None** |
| Session credential | GUID + 256-bit secret cookie | **GUID only, in the URL** |
| Abort | Cooperative `signal` + `onEvent` | **SIGTERM to the child process** |
| Progress | Structured events with counts | **Parsed from the CLI's own log lines** |
| Purpose | Public service | **Prove the flow; hand v2 a working skeleton** |

Success criterion: *a person on the LAN creates a GUID, logs into Microsoft,
sees their notebook list, exports a notebook, watches the log, interrupts it if
they want, downloads a zip, and erases the session.* Nothing more.

---

## 1. Decisions (locked for the POC)

| Area | Decision |
|---|---|
| Execution model | CLI subprocesses (`spawn`) inside the runner container |
| Container model | One long-lived `runner` container; global concurrency **1** |
| State | `/data/<guid>/state.json`, read/written by the app |
| Credential flow | Browser → app → runner; app proxies the body without parsing |
| MFA | Both kinds: code via child **stdin**, number-match via **log scrape** |
| Auth validity | `auth.json` existence + log evidence; optional `webauth check` preflight |
| Notebook selection | Prefer `--notebook-link <url>` from the list output |
| Export | `--non-interactive --notebook-link … --output-dir /data/<guid>/out` |
| Interrupt | `SIGTERM` to the child, then `SIGKILL` after a grace period |
| Progress | Log-line parsing; counter, **not** a percentage |
| Artifact | Zip streamed on demand by the runner |
| Erase | Kill job → `rm -rf /data/<guid>` → forget |
| TTL | 12 h absolute on session data, 60 s sweeper |
| Edge / TLS | None. `localhost:3000` or the LAN IP |
| Abuse control | None, by decision |
| Auth of the session | GUID in the URL, nothing else |
| Password in argv | Accepted and documented — see §4.2 |

---

## 2. The constraint, and what it costs

PLAN-v2 §6 asked four packages for new APIs. Without them, each gap needs a
workaround, and the workaround is worse in a specific, nameable way. This table
is the honest price of the POC, and it is the reference for the v2 build order.

| PLAN-v2 capability | Without the package change | POC workaround | Cost |
|---|---|---|---|
| `login({promptCode, onEvent, signal})` | CLI prompts on a readline over `process.stdin` | Pipe stdin, write the code + `\n` | Works. Readline is TTY-agnostic. |
| Challenge events | No events; the prompt text is the only signal | Match `Enter the verification code: ` on stdout | Brittle to wording changes in the package |
| Number-match display | Log line `Enter the number:  123456` | Scrape the line, show the number, wait passively | Same brittleness |
| **Login exit code** | `login()` catches everything and logs; **exit status stays 0** on failure (`auth.js:1577-1580`, no `process.exit`) | Success = `auth.json` exists **and** `Authentication successful!` seen | **A success/failure decision made from a log line** |
| Structured error codes | None exist | Map log text + exit code to a small enum | New errors look like `unknown` |
| `signal` on export | No cancellation API | `SIGTERM` → 10 s → `SIGKILL` | Files written mid-abort may be truncated |
| `onEvent` progress | No events | Parse `Exporting: <page> ...` | **No denominator** — counter only, no percentage |
| `signal` on list-notebooks | None | `SIGTERM` on abandon | Cancel is not instant |
| `promptCode` threading | n/a | MFA prompt dies with the child | Abandoning login discards the prompt |

Two of these deserve emphasis because they are not merely "less polished":

- **A zero exit code does not mean login succeeded.** Any POC code that trusts
  the exit status of `microsoft-webauth login` is broken. The check is
  `auth.json` present **and** the success line observed.
- **There is no clean stop.** v2's "interrupt preserves partial output" was a
  library guarantee. Here it is an empirical property: the child is killed, and
  whatever Markdown was written before that is what the user gets, labelled
  partial. Truncated files are possible.

**Not affected.** Listing notebooks, exporting a named notebook, asset
downloading, link resolution, interstitial handling, and the blocking-screen
watcher all already work from the CLI. The POC exercises all of them.

---

## 3. Architecture

Two containers, one volume, no reverse proxy.

```
┌──────────────────────────────────────────────────────────┐
│ Browser  ·  React+TS build served by the app              │
│   GET  /                      → landing (GUID)           │
│   GET  /s/:guid               → session page              │
│   GET  /api/session/events    → SSE (state + log lines)   │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP, LAN or localhost
┌───────────────────────▼──────────────────────────────────┐
│ app  ·  Fastify + TypeScript  (Node 24)                   │
│   • /data mounted rw                                      │
│   • session store: state.json per GUID                    │
│   • FIFO job queue, global concurrency 1                  │
│   • SSE hub, ring buffer 500 lines                        │
│   • static React build (no CDN)                           │
│   • security headers + CSP                                │
└───────────────────────┬──────────────────────────────────┘
                        │ http://runner:8080  (no published port)
                        │ x-runner-token
┌───────────────────────▼──────────────────────────────────┐
│ runner  ·  Fastify sidecar  (Node 24)                    │
│   • /data mounted rw                                      │
│   • node_modules: the 3 published @msout packages         │
│   • Playwright + Chromium                                 │
│                                                          │
│   POST /login     → spawn  microsoft-webauth login       │
│   POST /mfa       → write to the login child's stdin      │
│   POST /list      → spawn  list-notebooks                │
│   POST /export    → spawn  onenote-export-nb             │
│   POST /abort     → SIGTERM / SIGKILL the child          │
│   POST /erase     → kill + rm -rf /data/<guid>           │
│   GET  /events    → SSE of stdout/stderr lines           │
│   GET  /artifact  → streamed zip (archiver)              │
└──────────────────────────────────────────────────────────┘
```

`compose.yaml`:

```yaml
services:
  app:
    build: ./app
    ports: ["3000:3000"]
    volumes: ["./data:/data"]
    environment:
      DATA_ROOT: /data
      RUNNER_URL: http://runner:8080
      RUNNER_TOKEN: ${RUNNER_TOKEN:?set RUNNER_TOKEN in .env}
      SESSION_TTL_HOURS: "12"
    depends_on: [runner]

  runner:
    build: ./runner
    # No `ports:` — the runner is reachable only from the app, over the
    # internal compose network. Nothing on the LAN can talk to it.
    volumes: ["./data:/data"]
    environment:
      ONENOTE_EXPORT_LOG_DIR: /data/logs
      # One scratch dir per child process; see §8.
      RUNNER_TMP: /tmp
```

Why the runner is reachable only internally: it is the process that receives
passwords and holds `auth.json`. It must not be an endpoint anyone can address.

---

## 4. Repository layout

```
microsoft-onenote-exporter-web/
├── PLAN.md, PLAN-v2.md, PLAN-v3(POC).md
├── DONATE.md                      # committed addresses (banner target)
├── compose.yaml  .env.example
├── app/
│   ├── Dockerfile
│   ├── package.json               # fastify, archiver-free (zip lives in runner)
│   ├── tsconfig.json  vite.config.ts
│   ├── index.html  (Vite root)
│   └── src/
│       ├── server/
│       │   ├── index.ts           # bootstrap
│       │   ├── config.ts
│       │   ├── paths.ts           # /data/<guid>/… layout, GUID validation
│       │   ├── session-store.ts   # read/write state.json
│       │   ├── queue.ts           # FIFO, concurrency 1
│       │   ├── runner-client.ts   # HTTP to runner, SSE subscribe
│       │   ├── flows.ts           # login / list / export orchestration
│       │   ├── log-parser.ts      # see §6.2
│       │   ├── sse.ts             # hub + ring buffer
│       │   ├── sweeper.ts         # TTL
│       │   └── routes/{landing,session,events}.ts
│       └── web/
│           ├── main.tsx  App.tsx
│           ├── api.ts
│           ├── pages/{Landing,SessionPage}.tsx
│           └── components/{Banner,AuthBlock,NotebooksBlock,ExportBlock,LogPanel}.tsx
├── runner/
│   ├── Dockerfile
│   ├── package.json               # fastify, archiver; @msout/* pinned, no patches
│   └── src/index.ts               # ~300 lines, the whole sidecar
├── test/
│   ├── log-parser.test.ts         # unit, no browser
│   ├── queue.test.ts
│   └── e2e.md                     # the manual script from §13
└── data/                          # gitignored, the live sessions
```

### 4.1 Pinned versions

```jsonc
"dependencies": {
  "@msout/microsoft-webauth":              "0.1.8",
  "@msout/microsoft-onenote-list-notebooks": "0.0.7",
  "@msout/microsoft-onenote-export-notebook": "0.3.7"
}
```

Exact versions, no `^`. A floating range silently changes the CLI surface — and
under this constraint the CLI surface *is* the API. `microsoft-onenote-exporter`
(the umbrella CLI) is **not** used by the POC; it is a wrapper whose value here
is zero.

`microsoft-webauth` requires Playwright `^1.63.0`; the runner image installs
Chromium for that exact version and sets
`PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright`.

### 4.2 The password in argv — accepted, not solved

`microsoft-webauth login` takes `--password <value>`. There is no env, stdin or
file alternative in the published CLI, so for the duration of the login the
password is in the runner container's process table.

For the POC this is bounded by:

- one job at a time, so at most one such process exists,
- the runner runs as non-root `node`, no other accounts, no shell access,
- nothing else is reachable inside the container,
- the process is gone when the job ends.

It is **not** invisible, and the POC docs must say so rather than imply
otherwise. The fix is a package change — accept the password from an env var,
a fd, or a file — and belongs at the top of the v2 package work, above the
features PLAN-v2 §6 listed.

---

## 5. On-disk layout and state

```
data/
└── <guid>/
    ├── state.json         # owned by the app
    ├── auth.json          # written by microsoft-webauth
    ├── auth-meta.json     # written by microsoft-webauth
    ├── logs/app.log       # ONENOTE_EXPORT_LOG_DIR → per-session
    ├── out/<Notebook>/    # markdown + assets
    └── tmp/               # child scratch (see §8)
```

`ONENOTE_EXPORT_LOG_DIR` is honoured by all three packages, so one env var points
every log at the session directory instead of a shared `~/.local/state`. This
matters: it is what makes a session erasable with one `rm -rf`.

### 5.1 `state.json`

```jsonc
{
  "guid": "3f2a…",
  "createdAt": "2026-10-02T19:40:12.000Z",
  "expiresAt": "2026-10-03T07:40:12.000Z",
  "auth":    { "state": "none|logging-in|valid|failed", "email": null, "at": null },
  "mfa":     { "kind": null, "number": null, "askedAt": null },
  "notebooks": { "state": "idle|listing|loaded|failed", "items": [], "error": null },
  "export":  { "state": "idle|queued|running|done|partial|failed|aborted",
               "notebook": null, "notebookUrl": null,
               "pagesExported": 0, "error": null, "artifact": null },
  "job":     { "id": "job-7", "kind": "export", "state": "queued|running|ended",
               "queuedAt": "…", "startedAt": "…", "endedAt": "…",
               "logSeq": 412 },
  "logSeq": 412
}
```

Written atomically (`write` to `state.json.tmp`, `rename`). Read once per request;
never held open. One writer (the app), so no locking story is needed.

GUID validation on every route: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
before it is ever joined to a path. A traversal bug here would be a
whole-filesystem read.

---

## 6. How each flow works, against the unmodified CLIs

### 6.1 Login

```
node /runner/node_modules/@msout/microsoft-webauth/src/index.js \
  login --email <email> --password <password> \
  --auth-file /data/<guid>/auth.json
```

`--notheadless` is never passed: `isAutomated` is true because both credentials
are present, so the flow is headless by default (`auth.js:1228`) and the
"press ENTER after manual login" branch (`auth.js:1552`) is unreachable. Good —
that branch would hang forever on a pipe.

`HOME` is set per child to `/data/<guid>/tmp` (§8), so nothing leaks to a shared
home directory between sessions.

| Log line | POC interpretation | State written |
|---|---|---|
| `Attempting automated login for <email>...` | started | `auth.logging-in` |
| `Enter the verification code: ` | **code challenge** — the UI switches to a code input | `mfa.kind = "code"` |
| `Number Matching MFA detected ("Approve sign in request" screen).` | number challenge | `mfa.kind = "number"` |
| `  Enter the number:  123456` | the number itself | `mfa.number = "123456"` |
| `Authentication successful! State saved to …` | success | `auth.valid` |
| `Authentication failed or cancelled: …` + `Possible cause: …` | failure | `auth.failed` + mapped error |

Number-match is **passive**: the page waits for the element to disappear while
the user approves in Microsoft Authenticator. The UI shows the number, a
countdown, and **cancel** — no Approve button. This is PLAN-v2 §6.1's corrected
model, which holds because we did not need a package change to get it.

**Success test — both conditions, never one:**

```ts
const ok = existsSync(authFile) && sawLine("Authentication successful!");
```

`webauth check --auth-file …` is available as an optional preflight. Its own
exit code is also always 0, so it is read by scraping
`Authentication file found. You are authenticated.` — and note that on a dead
session `checkAuth()` **deletes** the auth file (`auth.js:1622-1625`), which the
UI must present as "your session expired, please sign in again", not as an error.

### 6.2 List notebooks

```
node …/@msout/microsoft-onenote-list-notebooks/src/index.js \
  list --auth-file /data/<guid>/auth.json
```

Output shape (`src/index.js:29-37`):

```
Available Notebooks:
1. Personal (https://…/onenote/…?wdOrigin=…)
2. Work (https://…)
```

Parse `/^\s*(\d+)\.\s+(.+?)\s+\((https?:\/\/[^)]+)\)\s*$/`. Lines are prefixed by
the logger with `[Oct 02 19:41:03] [INFO] ` and wrapped in chalk — strip ANSI
first (`/\u001b\[[0-9;]*m/g`) and take the remainder after the last `] `.

Exit code 1 on failure (`process.exitCode = 1`), so this one flow *can* trust its
exit status. Contradicting signals (exit 0, no parsable line) are reported as
`no_notebooks`, never as an empty successful list.

### 6.3 Export

```
node …/@msout/microsoft-onenote-export-notebook/src/index.js \
  export --auth-file /data/<guid>/auth.json \
  --notebook-link "<url>" \
  --output-dir /data/<guid>/out \
  --non-interactive
```

- `--notebook-link` from the list output, so the notebook is identified by URL
  and not by a name that could collide or contain shell-hostile characters.
- `--non-interactive` fails fast if the target is missing and implies
  `--nopassasked`, so password-protected sections are skipped rather than
  waiting for a keypress that cannot arrive.
- **The package's `entrypoint.sh` is bypassed on purpose.** It deliberately exits
  0 even when the export fails (`entrypoint.sh` §"So the status is captured
  instead of aborting"), because it is the tolerant container-wrapper path.
  Calling `src/index.js` directly preserves exit codes `0 / 1 / 2`.
- `ONENOTE_EXPORT_LOG_DIR=/data/<guid>/logs` keeps dumps and `app.log` inside the
  session, so erase takes them with it.

| Log line | POC interpretation | Effect |
|---|---|---|
| `Auto-selecting notebook: "<name>"` / `Exporting notebook: <name>` | target accepted | `export.state = running` |
| `Refusing to show the notebook picker: …` | neither `--notebook*` given | `error = no_target`, exit 2 |
| `Notebook "<name>" not found in list. Available: …` | stale list / renamed notebook | actionable error listing names |
| `[Section] <name>` | section entered | log line, step counter |
| `Found <n> pages. Starting extraction...` | traversal began | — |
| `Exporting: <page> ...` | one page done | `pagesExported++` → SSE |
| `Total Pages: <n>` / `Total Assets: <n>` | final totals | progress finalised |
| `Files saved in: <dir>` | output confirmed | artifact path recorded |
| `Export complete!` | clean run | `export.state = done` |
| `Export finished with errors - <n> item(s)…` | partial | `export.state = partial` |
| `Export stopped early - <reason>.` | partial | `export.state = partial` |
| `Unexpected internal failure during the export (this is a bug)` | dead tab / renderer crash | `export.state = failed`, exit 1 |

**Progress has no denominator.** The package reports totals only at the end, so
the UI shows `N pages exported` and, once `Total Pages:` appears, switches to
`N / total`. A fake percentage bar is not built; PLAN-v2 §7.1's structured counts
are what makes that possible, and those need the package change.

### 6.4 Log parsing

Every child gets `env: { FORCE_COLOR: '0', NO_COLOR: '1' }` so the log is plain
text from the start; ANSI stripping is still applied, because a nested logger or
a future package version may not honour those.

```
[Oct 02 19:41:03] [INFO] Exporting: Meeting notes ...
   ↓
{ ts: 1759426863000, level: "info", text: "Exporting: Meeting notes ...", raw: "…" }
```

Three regexes, all in `log-parser.ts`, all unit-tested against captured real
output: timestamp+level, notebook list line, and the signal table entries above.
Multi-line messages are re-prefixed by the logger already, so a physical line
that does not match is emitted as continuation text rather than dropped.

---

## 7. Jobs, queue, interrupt

`queue.ts` — an in-process FIFO, **concurrency 1**, one job per session.

- `POST /api/session/login|list|export` enqueues, returns `202` with
  `{ jobId, position }` immediately. The UI never waits on an HTTP request that
  can take 40 minutes.
- A second job for the same session returns `409` and names the running job.
- Queue state lives in `state.json` (`job.position`) so a refresh shows it.

**Global serialisation is the POC's real cost:** one 30-minute export blocks every
other session, including logins. That is accepted, and the UI must say so —
"1 export running ahead of you, started 19:41" — rather than showing a countdown
that will not move (PLAN-v2 §2.6's concern, in miniature). v2 replaces this with
the pool.

**Interrupt**, `POST /api/session/export/abort`:

1. `SIGTERM` to the child's process group.
2. Wait 10 s (Chromium needs to unwind).
3. `SIGKILL` the group if still alive; reap.
4. Count the files under `out/`; set `export.state = "partial"`.
5. The artifact endpoint serves the partial zip, **labelled partial in the UI
   and in the filename** (notebook-partial-<ts>.zip).

Truncated files are possible and are the honest consequence of killing a
traversal rather than being told to stop. v2 replaces this with `signal`.

---

## 8. Child process environment

Each child is spawned with:

| Variable | Value | Why |
|---|---|---|
| `HOME` | `/data/<guid>/tmp/home` | Playwright and any tool that writes to `$HOME` stays inside the session, so erase is complete |
| `ONENOTE_EXPORT_LOG_DIR` | `/data/<guid>/logs` | one env var covers all three packages |
| `PLAYWRIGHT_BROWSERS_PATH` | `/home/node/.cache/ms-playwright` | baked into the image |
| `NO_COLOR` / `FORCE_COLOR` | `1` / `0` | parseable logs |
| `stdin` | `pipe` | MFA code injection |
| `stdio` | `['pipe','pipe','pipe']` | never `inherit` — inherited stdio would put raw logs on the container's stdout and break the "no logs in `docker logs`" test |

---

## 9. Events / SSE

```
GET /api/session/events        (browser  → app)
GET /events                    (app      → runner)
```

One hop each way, no shared bus. The runner owns a per-session line buffer
(500 lines) with monotonically increasing `seq`; the app mirrors it and
re-broadcasts to the browser.

Event types — deliberately a subset of PLAN-v2 §7.1, because the POC cannot
produce half of them:

```
snapshot  auth-state  mfa-required  notebooks  job-state
export-progress  log  artifact-ready  error  keepalive
```

- `snapshot` on connect, from `state.json`: the browser gets its state without a
  separate fetch, so a refresh mid-export restores everything.
- `keepalive` comment every 15 s.
- Ring buffer, 500 lines; a `seq` older than the buffer yields a fresh
  `snapshot` instead of a gap. Replay is a v2 nicety — the POC reconnects with
  `Last-Event-ID` and, if the id has aged out, gets a snapshot.
- Multiple tabs fan out from one runner subscription. The POC does **not**
  re-synchronise actions across tabs beyond what the snapshot gives for free;
  v2 §7.4 keeps the stronger contract.

---

## 10. Frontend

React 18 + TypeScript + Vite. Build output is copied into the app image and
served by Fastify: **no CDN, no third-party JS, no analytics, no remote fonts.**
Same rule as PLAN-v2 §9.

**Landing** (`/`): GUID input, *generate for me* (`crypto.randomUUID()`), *go to
my session*. The generated GUID is shown with a copy button and an explicit
warning that it cannot be recovered — there is no reset, by design.

**Session** (`/s/:guid`):

- Banner: countdown to `expiresAt` (absolute ISO-8601 from the server, so a
  skewed client clock cannot shorten or extend it), *erase session* (inline
  confirm, not a modal route), *github project* (new tab), *donate* (a page
  rendering `DONATE.md`, addresses committed to the repo so they are auditable).
- **Authenticate** block: consent checkbox (unchecked) above the password field,
  quoting PLAN-v2 §9.3 verbatim — the tool auto-accepts Microsoft's Terms of Use
  and security prompts. On a challenge the block swaps itself: code input, or
  the number-match view (big number, "open Microsoft Authenticator and enter
  this number", countdown, cancel, **no Approve button**).
- **List notebooks**: disabled until `auth.valid`. Each row fills the export
  block. Names render as **text**.
- **Export**: notebook name or URL, *start*, live log panel, *interrupt*, and
  the download link when the artifact exists — labelled partial when it is
  partial.

Security headers (PLAN-v2 §9.4) are cheap and stay:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob:; connect-src 'self'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

No `dangerouslySetInnerHTML` anywhere. No CSRF defence is implemented — with
GUID-only auth in the URL there is no ambient credential to ride on beyond the
GUID itself; that argument stops holding the moment the GUID+secret cookie
arrives, which is exactly why it is a v2 blocker.

---

## 11. Erase and TTL

Sweeper every 60 s over `state.json` files.

**Erase** — four steps, in this order, no state machine:

1. Kill any child process for that GUID (`SIGTERM` → `SIGKILL`).
2. `rm -rf /data/<guid>`.
3. Reject subsequent requests for that GUID with `404` — served from an in-memory
   tombstone set, so a deleted session cannot be resurrected by a queued request.
4. Emit `session-erased`; the UI returns to the landing page.

PLAN-v2 §11's state machine exists because container removal and directory
deletion are independent operations. Here there is no per-session container to
remove: one step fails, and the failure is visible and retryable by deleting the
directory again. `shred` is not attempted — on CoW/SSD it is theatre, and PLAN-v2
§11 already said so.

UI wording, unchanged from PLAN-v2 §11: *"We deleted everything this service
stored for this session."* Never *"nothing remains anywhere."*

TTL: 12 h absolute on `expiresAt`, created at GUID generation. Expired sessions
are erased by the same path. There is no idle TTL in the POC — with concurrency
1, holding a slot open for an idle session blocks everyone, which is the exact
DoS PLAN-v2 §2 fixed for v2. Here the honest trade is the reverse: one busy user
can stall the service for the duration of one export.

---

## 12. Error taxonomy

Derived only from what the unmodified CLIs expose. Small on purpose.

| Code | Detected from | Retry? |
|---|---|---|
| `bad_credentials` | `Authentication failed` + no MFA/`Possible cause` text | user retries |
| `mfa_timeout` | no `Authentication successful!` within the challenge window | user retries |
| `captcha_required` | any line mentioning captcha / "verify you're human" | no — tell the user to use the local CLI |
| `microsoft_blocked` | datacenter-IP block text | no — same message |
| `notebook_not_found` | `Notebook "<x>" not found in list` | yes, pick again |
| `no_target` | exit 2 + `Refusing to show the notebook picker` | never — POC bug |
| `export_failed` | exit 1 | maybe |
| `export_partial` | `Export finished with errors` | yes |
| `aborted` | we killed it | yes |
| `no_auth` | `auth.json` missing at job start | user logs in |
| `busy` | another job for this session | yes |
| `low_disk` | `statfs` below threshold → `507` | later |
| `unknown` | anything else | reported verbatim, never swallowed |

PLAN-v2 §6's requirement that MFA failures **must not be swallowed** is honoured
from the outside: because the package swallows them internally (`auth.js:1502`
logs `Post-password verification handling skipped or failed`), the sidecar's job
watchdog is what guarantees a hung login is reported rather than waited on
forever. **Job timeout: 15 min for login, 90 min for export.** A timeout is a
hard `SIGKILL` plus a `failed` state, not a silent stall.

---

## 13. Work sequence

Each step ends with something a human can verify. Six steps, in order.

### Step 1 — Skeleton and image
`compose.yaml`, app and runner `Dockerfile`s, runner sidecar with `/healthz`
only, GUID route + landing page with a hardcoded "hello".

*Done when:* `docker compose up`, `curl localhost:3000` returns the landing page,
`docker compose exec runner curl localhost:8080/healthz` returns ok, Chromium
launches inside the runner and loads a local page.

### Step 2 — Login end to end (**gate**)
`spawn` + stdin pipe + log parser + MFA states + `state.json` writes. No UI yet;
`curl` only.

*Done when:* `POST /api/session/login` with a real account reaches
`Authentication successful!` and `auth.json` appears — **with MFA**, since a POC
that only works on MFA-less accounts does not prove the flow. Then: wrong password
reports `bad_credentials` instead of "success" (the exit-code-0 trap), and a
number-match login shows exactly one number with no Approve button.

### Step 3 — List notebooks
*Done when:* the real list renders, and a bogus `--notebook-link` produces
`notebook_not_found`.

### Step 4 — Export, interrupt, artifact
*Done when:* a real notebook exports to markdown + assets, `Total Pages` appears,
progress increments live, *interrupt* yields a labelled-partial download, and the
zip streams without buffering in the app.

### Step 5 — React UI and SSE
*Done when:* the whole flow works from the browser, and **refreshing mid-export
restores state and does not restart the export**.

### Step 6 — Erase, TTL, docs
*Done when:* erase removes the directory and 404s afterwards; a session past
12 h is swept; `README` explains how to run it and states the §4.2 argv
limitation.

Steps 1-4 need no frontend at all. If the POC stalls, that is where it is
closest to done.

---

## 14. Acceptance checks

Automated (`test/`):

- `log-parser` reproduces every row of the §6 signal tables from captured
  fixtures — these regexes are the POC's contract with the packages, so they are
  tested like code, not eyeballed.
- A GUID that is not a UUID never reaches the filesystem.
- Session A cannot read session B's `state.json` or artifact; a path containing
  `..` is rejected.
- A session past `expiresAt` cannot download.
- Queue: two concurrent requests never run two children; same-session second
  request is `409`.
- `abort` leaves the process group gone and the partial files present.

Manual (`test/e2e.md`):

- **No credential in any log.** After a login: `grep -r <password>` in
  `docker logs app`, `docker logs runner`, `data/<guid>/logs/app.log`, and the
  app's own stdout must all come back empty.
- **`ps` inspection is documented, not hidden:** `docker compose exec runner ps
  -ef` shows the login child with `--password` for its duration. The README says
  so out loud.
- Number-match MFA shows one number, no Approve button, and a countdown.
- Refresh mid-export: progress restored, export not restarted.
- Interrupt → partial zip, labelled partial.
- Erase → directory gone, `404` afterwards, sweeper agrees.
- Two browsers, two GUIDs, interleaved: no cross-talk in logs or downloads.

---

## 15. Deferred to PLAN-v2, and why

| Deferred | Reason |
|---|---|
| Package changes (`signal`, `onEvent`, structured codes, structured errors) | forbidden by the constraint; this is the POC's core cost |
| Runner pool, per-session containers, slot claims, rebind | concurrency 1 makes it unobservable |
| SQLite | one writer, one file, no queries needed |
| Caddy, TLS, HSTS | local network, operator's responsibility |
| Layered rate limits, Microsoft-block detection UX | no abuse control by decision |
| GUID + 256-bit secret cookie | POC; carried as a launch blocker from PLAN-v2 §13.1 |
| Auth-expiry preflight | cheap (`webauth check`), scheduled as a stretch after step 3 |
| Memory watchdog at 80 % of cgroup limit | cgroup `--memory` is the POC's guard |
| Deploy drain / maintenance banner | single box, operator-driven restarts |
| Journal-mode copy-on-write / LUKS erase | POC erase is `rm -rf`, stated as such |

---

## 16. Known POC limitations

Stated plainly, because a POC that oversells itself is worse than one that does
not.

| Limitation | Consequence | v2 fix |
|---|---|---|
| Password in the runner's argv for the login duration | Visible to anything inside that container | package change: env / fd / file |
| All success/failure detection is log parsing | A package reword breaks it silently | structured events + exit codes |
| No cooperative abort; `SIGTERM` may truncate a file | Partial artifacts can contain half-written markdown | `signal` in the package |
| Progress has no denominator | No percentage bar | `onEvent` counts |
| Global concurrency 1 | One long export stalls every other session | pool + per-session runners |
| GUID in the URL | A leaked URL is a full takeover until 12 h elapse | GUID + secret cookie |
| No TLS | Credentials cross the LAN in clear | Caddy + HSTS |
| No rate limits | Anyone who can reach the port can consume the single slot | layered limits |
| Erase is `rm -rf` | Not a cryptographic erase; CoW/SSD may retain blocks | LUKS |
| Chromium needs unprivileged userns | Otherwise `--no-sandbox`, which disables the renderer sandbox | documented host prerequisite (§18) |

---

## 17. Config reference

| Variable | Default | Used by |
|---|---|---|
| `DATA_ROOT` | `/data` | app |
| `RUNNER_URL` | `http://runner:8080` | app |
| `RUNNER_TOKEN` | *required* | both — `x-runner-token` on every runner route |
| `SESSION_TTL_HOURS` | `12` | app |
| `LOGIN_TIMEOUT_MS` | `900000` | app |
| `EXPORT_TIMEOUT_MS` | `5400000` | app |
| `MIN_FREE_DISK_MB` | `2048` | app → `507` below it |
| `ONENOTE_EXPORT_LOG_DIR` | `/data/logs` (overridden per child) | runner |
| `CHROMIUM_NO_SANDBOX` | `0` | runner compose only — see §18 |
| `RUNNER_TMP` | `/tmp` | runner |

---

## 18. Runner runtime flags

Keep the flags that are **technical requirements**, drop the rest.

Required — the POC breaks without them:

```
--init                       # Node is PID 1 and will not reap Chromium zombies
--shm-size=1g                # Docker's 64 MB default crashes Chromium
--tmpfs /tmp:rw,nosuid,size=1g,uid=1000,gid=1000
--user=node
--memory=4g --memory-swap=4g # one browser, one export, real notebooks
--cpus=2
--pids-limit=512
--cap-drop=ALL --security-opt=no-new-privileges
--network=msout_internal
```

Chromium sandbox: **do not add `--no-sandbox`.** The host needs
`kernel.unprivileged_userns_clone=1` (and
`kernel.apparmor_restrict_unprivileged_userns=0` where applicable); this is a
host prerequisite, documented in the README, not an assumption. If a host cannot
provide it, `CHROMIUM_NO_SANDBOX=1` in compose turns on the documented fallback
and the README must say the renderer sandbox is then disabled.

Not in the POC: `--read-only` (the packages write more than the POC can
enumerate), a memory watchdog, boot reconciliation, health-based draining.

`--dodump` and `--screenshot` are **never** passed: dumps contain the
authenticated DOM with live cookies and tenant hostnames. No debug override
exists in the sidecar. `ONENOTE_EXPORT_LOG_DIR` still catches the package's own
dumps, and they live and die inside the session directory.

---

## 19. Licence

MIT, consistent with the rest of the family. The POC **consumes** the three
packages from npm and modifies none of them.