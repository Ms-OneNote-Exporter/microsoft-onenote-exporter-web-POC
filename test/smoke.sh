#!/usr/bin/env bash
#
# End-to-end smoke test, fake mode.
#
# Runs the real app and the real runner on localhost with MSOUT_FAKE=1, and
# drives the whole flow with curl: create a session, sign in (including MFA),
# list notebooks, export, watch progress, interrupt, download the zip, erase.
#
# What this proves: the HTTP contract, the SSE stream, the queue, the log parser,
# the zip and the erase path all work together.
#
# What it does NOT prove: anything about Microsoft. The fake CLIs emit the real
# packages' log lines, but they are not Microsoft, and a selector change or a new
# interstitial screen upstream will only show up against a real login.
#
# Usage:  test/smoke.sh          (expects `npm run build` to have been run)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
DATA="$ROOT/data-smoke"
APP_PORT="${APP_PORT:-3999}"
RUNNER_PORT="${RUNNER_PORT:-8099}"
TOKEN="smoke-token"
GUID="3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b"
GUID2="9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"

pass=0
fail=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fail=$((fail+1)); }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
contains() { if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else bad "$3 (missing '$2')"; fi; }

cleanup() {
  [ -n "${RUNNER_PID:-}" ] && kill "$RUNNER_PID" 2>/dev/null || true
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT

rm -rf "$DATA"
mkdir -p "$DATA"

if [ ! -f "$ROOT/shared/dist/cjs/index.js" ]; then
  echo "build first: npm run build" >&2
  exit 1
fi
if [ ! -f "$ROOT/runner/dist/index.js" ]; then
  echo "build first: npm run build" >&2
  exit 1
fi

say "starting runner and app (fake mode)"
RUNNER_TOKEN="$TOKEN" DATA_ROOT="$DATA" MSOUT_FAKE=1 RUNNER_PORT="$RUNNER_PORT" \
  node "$ROOT/runner/dist/index.js" > "$DATA/runner.log" 2>&1 &
RUNNER_PID=$!

DATA_ROOT="$DATA" MSOUT_FAKE=1 RUNNER_TOKEN="$TOKEN" PORT="$APP_PORT" \
  RUNNER_URL="http://127.0.0.1:$RUNNER_PORT" \
  node "$ROOT/app/dist/server/index.js" > "$DATA/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$RUNNER_PORT/healthz" >/dev/null 2>&1 && \
  curl -sf "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done

curl -sf "http://127.0.0.1:$APP_PORT/healthz" >/dev/null || { echo "app did not start"; cat "$DATA/app.log"; exit 1; }
ok "both processes are up"

say "health"
contains "$(curl -s "http://127.0.0.1:$RUNNER_PORT/healthz")" '"fake":true' 'runner reports fake mode'
contains "$(curl -s "http://127.0.0.1:$APP_PORT/healthz")" '"ok":true' 'app is healthy'

say "guid handling"
check "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/session?guid=not-a-guid")" 400 'a malformed guid is refused'
check "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/session?guid=../../etc")" 400 'a traversal attempt is refused'
check "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")" 404 'an unknown session is 404, not created'

say "create session"
CREATED=$(curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")
contains "$CREATED" "\"guid\":\"$GUID\"" 'session created'
contains "$CREATED" '"expiresAt"' 'the session carries an absolute expiry'
if [ -f "$DATA/$GUID/state.json" ]; then ok 'state.json written'; else bad 'state.json missing'; fi
check "$(stat -f '%Lp' "$DATA/$GUID/state.json")" 600 'state.json is owner-only'

say "sign in with MFA"
# The app forwards these bytes to the runner without parsing them.
MFA_LOGIN=$(curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/credentials?guid=$GUID" \
  -H 'content-type: application/octet-stream' \
  --data-binary '{"email":"smoke@example.invalid","password":"mfa"}')
contains "$MFA_LOGIN" '"jobId"' 'login accepted'

# Watch the event stream until the MFA challenge appears.
EVENTS=$(curl -s --max-time 20 "http://127.0.0.1:$APP_PORT/api/session/events?guid=$GUID" || true)
contains "$EVENTS" 'mfa-required' 'the browser is told a challenge is pending'
contains "$EVENTS" '"kind":"code"' 'the challenge is a code, not a number'

curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/mfa?guid=$GUID" \
  -H 'content-type: application/json' --data '{"code":"123456"}' >/dev/null

for _ in $(seq 1 40); do
  STATE=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")
  printf '%s' "$STATE" | grep -q '"state":"valid"' && break
  sleep 0.25
done
contains "$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")" '"state":"valid"' 'session is authenticated'

say "credential hygiene"
if grep -q '123456' "$DATA/app.log" 2>/dev/null; then bad 'the MFA code leaked into the app log'; else ok 'no code in the app log'; fi
if grep -q '123456' "$DATA/runner.log" 2>/dev/null; then bad 'the MFA code leaked into the runner log'; else ok 'no code in the runner log'; fi
if grep -q '123456' "$DATA/$GUID/state.json" 2>/dev/null; then bad 'the code was persisted'; else ok 'nothing persisted in state.json'; fi

say "list notebooks"
# The preflight check runs first, as a queued job, before the lister. Watch for
# it explicitly: without it, a broken preflight would look like a slow list.
(curl -s --max-time 30 "http://127.0.0.1:$APP_PORT/api/session/events?guid=$GUID" \
  | grep -m1 '"kind":"check"' > "$DATA/check-seen.txt" 2>/dev/null &)
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/list?guid=$GUID" >/dev/null
for _ in $(seq 1 60); do
  LIST=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")
  printf '%s' "$LIST" | grep -q '"state":"loaded"' && break
  sleep 0.25
done
contains "$LIST" '"checkedAt":"' 'the preflight recorded a verdict'
contains "$LIST" 'Personal' 'notebook names reached the session state'
contains "$LIST" 'onedote.cloud.microsoft' 'notebook urls reached the session state'

say "export"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/export?guid=$GUID" \
  -H 'content-type: application/json' --data '{"notebook":"Personal"}' >/dev/null
for _ in $(seq 1 60); do
  EXP=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")
  printf '%s' "$EXP" | grep -q '"state":"done"' && break
  sleep 0.25
done
contains "$EXP" '"state":"done"' 'the export finished'
# The fake exports 8 pages by default (FAKE_EXPORT_PAGES); both numbers have to
# come from the log, since the packages report the total only at the very end.
contains "$EXP" '"pagesExported":8' 'pages were counted from the log'
contains "$EXP" '"totalPages":8' 'the total from the log was picked up'
if [ -d "$DATA/$GUID/out/Personal" ]; then ok 'the export wrote files'; else bad 'no output directory'; fi

say "download"
STATUS=$(curl -s -o "$DATA/out.zip" -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/session/artifact?guid=$GUID")
check "$STATUS" 200 'the artifact downloads'
if [ -s "$DATA/out.zip" ] && head -c 2 "$DATA/out.zip" | grep -q 'PK'; then ok 'it is a real zip'; else bad 'not a zip'; fi
# The listing goes to a file rather than into a pipe: `grep -q` exits at the
# first match, which would SIGPIPE unzip, and `set -o pipefail` would then turn a
# successful check into a failure.
if command -v unzip >/dev/null; then
  unzip -l "$DATA/out.zip" > "$DATA/listing.txt" 2>/dev/null || true
  if grep -q 'Personal/' "$DATA/listing.txt"; then ok 'the zip contains the notebook'; else bad 'the zip has no notebook'; fi
fi

say "interrupt a running export"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/export?guid=$GUID" \
  -H 'content-type: application/json' --data '{"notebook":"Work"}' >/dev/null
sleep 0.7

# Checked here, while the export above is genuinely running: the app refuses a
# second export for the same session, and a check made after the export ended
# would pass for the wrong reason.
check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$APP_PORT/api/session/export?guid=$GUID" -H 'content-type: application/json' --data '{"notebook":"Personal"}')" 409 'a second concurrent export returns 409'
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/abort?guid=$GUID" >/dev/null
for _ in $(seq 1 60); do
  AB=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")
  printf '%s' "$AB" | grep -qE '"state":"(partial|failed)"' && break
  sleep 0.25
done
contains "$AB" '"partial":true' 'an interrupted export is marked partial'
contains "$AB" '"error":"aborted"' 'and reported as aborted, not failed'

say "a failed sign-in never looks like a success"
BADGUID="$GUID2"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session?guid=$BADGUID" >/dev/null
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/credentials?guid=$BADGUID" \
  -H 'content-type: application/octet-stream' \
  --data-binary '{"email":"smoke@example.invalid","password":"fail"}' >/dev/null
for _ in $(seq 1 40); do
  BAD=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$BADGUID")
  printf '%s' "$BAD" | grep -q '"state":"failed"' && break
  sleep 0.25
done
contains "$BAD" '"state":"failed"' 'a failed login is failed'
contains "$BAD" '"error":"bad_credentials"' 'and carries an actionable code'

say "a run that reached OneNote and found no notebook asks for a new sign-in"
# The 0.4.0 outcome. Before it, this run printed `Export complete!` with
# `Total Pages: 0` and exited 0, and this app showed a successful export
# containing nothing. Checked here because the two 0.4.0 outcomes are both
# failures: a global FAKE_EXPORT_MODE could only produce one at a time, so each
# session picks its own with the file the fake reads beside its auth.json.
NOSEC="33333333-3333-4333-8333-333333333333"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session?guid=$NOSEC" >/dev/null
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/credentials?guid=$NOSEC" \
  -H 'content-type: application/octet-stream' \
  --data-binary '{"email":"smoke@example.invalid","password":"whatever"}' >/dev/null
for _ in $(seq 1 40); do
  S=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=NOSEC")
  printf '%s' "$S" | grep -q '"state":"valid"' && break
  sleep 0.25
done
echo staleauth > "$DATA/$NOSEC/fake-export-mode"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/export?guid=$NOSEC" \
  -H 'content-type: application/json' --data '{"notebook":"Personal"}' >/dev/null
for _ in $(seq 1 60); do
  NOS=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$NOSEC")
  printf '%s' "$NOS" | grep -qE '"state":"(failed|partial|done)"' && break
  sleep 0.25
done
contains "$NOS" '"error":"auth_expired"' 'an unreachable notebook is reported as an expired session'
contains "$NOS" '"partial":false' 'and nothing is offered as a partial download'
# The wording the user reads is not checked here: a session carries the error
# *code*, and the browser turns it into text through ERROR_TEXT. Asserting on the
# message at this layer would be asserting on a string the API never sends. The
# wording is covered where it is produced, in export-outcome.test.ts.

say "an export that wrote nothing is failed, not partial"
# A real 0.4.0 outcome when a Microsoft modal covers the section list: the run
# reports "finished with errors" and `Total Pages: 0`, with nothing on disk.
NOWT="44444444-4444-4444-8444-444444444444"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session?guid=$NOWT" >/dev/null
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/credentials?guid=$NOWT" \
  -H 'content-type: application/octet-stream' \
  --data-binary '{"email":"smoke@example.invalid","password":"whatever"}' >/dev/null
for _ in $(seq 1 40); do
  S=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=NOWT")
  printf '%s' "$S" | grep -q '"state":"valid"' && break
  sleep 0.25
done
echo blocked > "$DATA/$NOWT/fake-export-mode"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/export?guid=$NOWT" \
  -H 'content-type: application/json' --data '{"notebook":"Personal"}' >/dev/null
for _ in $(seq 1 60); do
  NWT=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$NOWT")
  printf '%s' "$NWT" | grep -qE '"state":"(failed|partial|done)"' && break
  sleep 0.25
done
contains "$NWT" '"state":"failed"' 'a run that wrote nothing is failed'
contains "$NWT" '"error":"export_failed"' 'not partial'
# `partial` is what puts the download button on the page, and there is no file.
contains "$NWT" '"artifact":null' 'and no zip is offered'
contains "$NWT" '"pagesExported":0' 'having counted no pages, honestly'

say "export before signing in is refused"
FRESH="11111111-2222-4333-8444-555555555555"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session?guid=$FRESH" >/dev/null
check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$APP_PORT/api/session/export?guid=$FRESH" -H 'content-type: application/json' --data '{"notebook":"x"}')" 409 'an unauthenticated export returns 409'

say "an expired session is refused before it can fail obscurely"
EXPIRED="77777777-7777-4777-8777-777777777777"
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session?guid=$EXPIRED" >/dev/null
# Sign the session in, then make its session expire, then ask for a listing.
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/credentials?guid=$EXPIRED" \
  -H 'content-type: application/octet-stream' \
  --data-binary '{"email":"expired@example.invalid","password":"ok"}' >/dev/null
for _ in $(seq 1 40); do
  EX=$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$EXPIRED")
  printf '%s' "$EX" | grep -q '"state":"valid"' && break
  sleep 0.25
done
contains "$EX" '"state":"valid"' 'the second session signed in'
# Force this one session's preflight to report an expired Microsoft session.
echo expired > "$DATA/$EXPIRED/fake-check-mode"
EXPIRED_LIST=$(curl -s -X POST "http://127.0.0.1:$APP_PORT/api/session/list?guid=$EXPIRED")
contains "$EXPIRED_LIST" 'Sign in again' 'an expired session is told to sign in again'
contains "$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$EXPIRED")" '"state":"failed"' 'and the session is signed out'
if [ -f "$DATA/$EXPIRED/auth.json" ]; then bad 'the expired auth.json survived'; else ok 'the expired auth file was deleted'; fi

say "erase"
curl -s -X DELETE "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID" >/dev/null
check "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")" 404 'an erased session is gone'
if [ -d "$DATA/$GUID" ]; then bad 'the session directory survived erase'; else ok 'the session directory was removed'; fi
check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID")" 404 'an erased guid cannot be recreated'

say "the other session is untouched"
contains "$(curl -s "http://127.0.0.1:$APP_PORT/api/session?guid=$GUID2")" '"state":"failed"' 'erasing one session left the other alone'

say "web ui"
contains "$(curl -s "http://127.0.0.1:$APP_PORT/")" '<div id="root">' 'the landing page is served'
if [ -n "$(find "$ROOT/app/dist/public/assets" -name '*.js' 2>/dev/null)" ]; then ok 'the bundle is served from the same origin'; else bad 'no bundle found'; fi

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]