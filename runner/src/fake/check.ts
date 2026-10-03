/**
 * Fake `microsoft-webauth check`, at 0.1.9.
 *
 * This command only became usable at 0.1.9. Before that it reported success for
 * a dead session - it waited a fixed two seconds and asked whether the URL
 * happened to be a login host, and an empty auth file read as signed in - which
 * is why the POC deferred the auth-expiry preflight. 0.1.9 waits for either the
 * signed-in app or a login redirect, exits 1 when it cannot confirm, and only
 * deletes the auth file when Microsoft itself says the session expired.
 *
 * The outcomes are chosen by a scenario in FAKE_CHECK_MODE, because the whole
 * point of the preflight is to distinguish them:
 *
 *   ok        (default) the session is live
 *   expired   redirected to a login page; the auth file is deleted
 *   stale     never authenticated and never redirected
 *   unverifiable  the check itself failed (network)
 *   nofile    there is no auth file at all
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeLogger, parseArgs, sleep } from './logger';

const log = makeLogger('monthName');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const authFile = args['auth-file'];
  // The verdict can be forced per session, by dropping a file named
  // `fake-check-mode` beside the auth file. FAKE_CHECK_MODE alone is global to the
  // runner, so a test that needs one session expired could not leave another
  // session confirmed. A file in the session directory is the smallest way to
  // make one session's outcome differ from another's.
  let mode = process.env.FAKE_CHECK_MODE ?? 'ok';
  const override = join(dirname(authFile ?? '.'), 'fake-check-mode');
  if (authFile && existsSync(override)) {
    mode = readFileSync(override, 'utf8').trim() || mode;
  }

  log('DEBUG', 'Verifying authentication session...');

  if (!authFile || !existsSync(authFile)) {
    log('ERROR', `Not authenticated (no_auth_file). ${authFile} does not exist`);
    log('ERROR', 'Run "login" first.');
    log('ERROR', 'check failed (exit 1). No authenticated session could be confirmed. See the reason above.');
    process.exitCode = 1;
    return;
  }

  await sleep(200);

  if (mode === 'expired' || mode === 'stale') {
    log('WARN', 'Authentication session has expired. Deleting stale auth state.');
    // Only an `expired` verdict deletes the file. A check that merely could not
    // confirm leaves it in place, because the check failing is not evidence the
    // session is bad.
    if (mode === 'expired') rmSync(authFile, { force: true });
    const reason = mode === 'expired' ? 'expired' : 'stayed_unauthenticated';
    const detail =
      mode === 'expired'
        ? 'the session was redirected to login.live.com; stale auth state deleted'
        : 'the signed-in interface never rendered and the session was never sent to a login page; the auth file was left in place';
    log('ERROR', `Not authenticated (${reason}). ${detail}`);
    log('ERROR', 'Run "login" first.');
    log('ERROR', 'check failed (exit 1). No authenticated session could be confirmed. See the reason above.');
    process.exitCode = 1;
    return;
  }

  if (mode === 'unverifiable') {
    log('DEBUG', 'Session verification encountered an error (timeout/network): net::ERR_TIMED_OUT');
    log(
      'ERROR',
      'Not authenticated (unverifiable). could not verify the session (net::ERR_TIMED_OUT); the auth file was left in place',
    );
    log('ERROR', 'Run "login" first.');
    log('ERROR', 'check failed (exit 1). No authenticated session could be confirmed. See the reason above.');
    process.exitCode = 1;
    return;
  }

  log('SUCCESS', 'Authentication file found. You are authenticated.');
  writeFileSync(
    `${authFile}.checked`,
    new Date().toISOString(),
    { flag: 'a' },
  );
}

void main();