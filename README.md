# microsoft-onenote-exporter-web (POC)

A small web service that exports a OneNote notebook to Markdown, using the
existing [`@msout/*` packages](https://github.com/Ms-OneNote-Exporter) as they
are published.

**It does not modify any of them.** They are installed from npm at pinned
versions and driven as subprocesses. Everything the packages would report
through events is recovered from their log output instead — see
[`PLAN-v3(POC).md`](./PLAN-v3(POC).md) for what that costs and why.

> **This is a proof of concept, for localhost or a trusted LAN.** There is no
> account, the session GUID is the only credential, there is no TLS, and there
> are no rate limits. Before putting it on the public internet, read §"Known POC
> limitations" below and PLAN-v2 §10/§13.1.

## What it does

1. You get a GUID (generated, or one you already have).
2. You sign in with Microsoft. MFA works, both the typed-code kind and the
   number-matching kind.
3. You list your notebooks and pick one.
4. You export it, watch the log, interrupt it if you want.
5. You download a zip. Partial exports are labelled partial.
6. You erase the session, and everything stored for it goes.

Nothing is stored between sessions, and a session is gone 12 hours after it was
created whether or not you come back.

## Running it

```bash
cp .env.example .env
$EDITOR .env          # set RUNNER_TOKEN: openssl rand -hex 32
docker compose up --build
```

Then open <http://localhost:3000>.

### Chromium's sandbox

The runner starts Chromium with its renderer sandbox **enabled**. On most hosts
that needs:

```bash
sudo sysctl -w kernel.unprivileged_userns_clone=1
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # Debian/Ubuntu
```

Check with `docker compose exec runner node -e "..."` if a login fails to start a
browser. If your host genuinely cannot provide unprivileged user namespaces,
`CHROMIUM_NO_SANDBOX=1` in `.env` is the documented fallback — it disables the
renderer sandbox, which is the reason a browser runs in that container at all.

### Trying it without a Microsoft account

```bash
cp .env.example .env      # set MSOUT_FAKE=1
npm install && npm run build
./test/smoke.sh
```

`MSOUT_FAKE=1` makes the runner spawn stand-in CLIs that emit the real packages'
log lines — the MFA prompt, `Enter the number:`, `Authentication successful!`,
`Exporting:`, `Total Pages:`, `Export complete!` — and write real files. The
whole pipeline runs with no account and no Chromium download. It is how the test
suite drives the flow, and it is a fair way to see the UI.

It does **not** prove anything about Microsoft.

## Layout

```
compose.yaml      two containers, one bind-mounted data directory
shared/           GUID validation, session paths, the state/event contract
runner/           the sidecar that spawns the @msout CLIs and holds credentials
app/              Fastify server, session state, job queue, SSE
app/src/web/      React UI (self-hosted, no CDN)
test/smoke.sh     end-to-end run against the real app and runner
data/             live sessions: auth.json, exports, logs. Never commit.
```

`data/` holds Microsoft cookies and your exported notes. It is gitignored, it is
mode 0700, and erasing a session deletes it.

## Development

```bash
npm install
npm test                       # 298 tests across the three workspaces
npm run typecheck
npm run build

# Two processes, for editing:
npm run dev:runner             # tsx watch, port 8080
npm run dev:app                # server on 3000 + Vite on 5173 with /api proxied
```

The Vite dev server proxies `/api` to the app, so `EventSource` behaves the same
in development as it does in the image.

## How it fits together

```
browser ──► app ──► runner ──► microsoft-webauth / list-notebooks / export-notebook
   │         │         │
   │         │         └── spawns one child at a time, streams its output as events
   │         └──────────── writes state.json, runs the queue, fans out SSE
   └────────────────────── React, same origin
```

Three decisions worth knowing before reading the code:

**A login is judged on three signals, not one.** Success needs `auth.json` on
disk, the success line in the log, **and** exit 0 — the rule lives in
`app/src/server/flows.ts`.

That was written when `microsoft-webauth@0.1.8` exited 0 on a *failed* login:
verified against a real capture, now kept as `login-failed-0.1.9.*` beside the
0.1.9 one. `0.1.9` fixed the exit code, and the rule stayed — being stricter than
necessary is free, and trusting a package's idea of what exit 0 means is how a
session ends up believing it is signed in when it is not.

**An expired Microsoft session is caught before it produces a mystery.**
`microsoft-webauth check` runs before every list and export. That was only
possible from 0.1.9: before it, `check` waited a fixed two seconds and asked
whether the URL happened to be a login host, so an *empty* auth file read as
signed in. Its verdict is cached for five minutes, and the three outcomes are
kept apart — an unverifiable check (usually the network) lets the operation
proceed rather than signing you out for a DNS blip.

**Credentials are proxied as bytes.** The browser builds the body; the app
forwards it untouched with a pass-through content-type parser; only the runner
decodes it, and the runner has no published port. No layer above the runner ever
holds a password as a parsed field.

**Interrupt means SIGTERM.** There is no cooperative cancel without a package
change, so an interrupted export is whatever was on disk when the signal landed —
labelled partial, in the UI and in the filename.

## Known POC limitations

| Limitation | Consequence |
|---|---|
| Password is visible in the runner's process list for the login duration | `microsoft-webauth login` takes `--password`; there is no env, fd or file option to use instead |
| Progress has no total until the end | The UI shows a page count, not a percentage |
| One job at a time, globally | A 30-minute export blocks every other session; the queue position is shown rather than hidden |
| Interrupt is SIGTERM, not a clean cancel | A file caught mid-write can be truncated |
| All success detection is log-line matching | A package that rewords a line loses a signal |
| GUID is the only credential | A leaked URL is a full takeover until the session expires |
| No TLS, no rate limits | Fine on localhost or a LAN; not fine on the internet |
| Chromium needs unprivileged user namespaces | Otherwise the renderer sandbox is disabled |

## Licence

MIT, consistent with the rest of the family. Consumes the `@msout/*` packages;
forks none of them.