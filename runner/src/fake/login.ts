/**
 * Fake `microsoft-webauth login`, at 0.1.9.
 *
 * Emits the real package's log lines, in its real order, in its real timestamp
 * format, and reproduces 0.1.9's exit codes - which is what changed in 0.1.9:
 * a failed login now exits 1 and adds a closing line saying so. Both were
 * captured from the published package, not assumed.
 *
 * Which path is taken is chosen by the password, so a tester can drive every
 * outcome without a Microsoft account:
 *
 *   anything else   success
 *   mfa             code challenge, read from stdin, 6 digits required
 *   number          number-match challenge, passively waited out
 *   fail            bad credentials, exit 1
 *   mfail           MFA code rejected, exit 1
 *   nolog           reaches the app but leaves no usable auth file, exit 1
 *                   (0.1.9's new failure mode, and the one a login that
 *                   "succeeded" used to produce)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { makeLogger, parseArgs, sleep } from './logger';

const log = makeLogger('monthName');

function readLine(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

/** One of the real package's login errors, thrown so the stack shape matches. */
class LoginError extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email ?? 'unknown';
  const password = args.password ?? '';
  const authFile = args['auth-file'];

  log('DEBUG', 'Authentication Module: v0.1.9 starting...');
  log('DEBUG', `Using auth file path: ${authFile}`);
  log('DEBUG', `Using meta file path: ${authFile?.replace(/\.json$/, '-meta.json')}`);
  log('INFO', `Attempting automated login for ${email}...`);
  await sleep(200);
  log('STEP', 'Automating login steps...');
  await sleep(200);
  log('INFO', 'Landing page detected. Clicking "Sign in"...');
  await sleep(200);
  log('DEBUG', 'Clicked "Sign in", waiting for login form...');
  await sleep(200);
  log('INFO', 'Email entered. Clicking "Next"...');
  log('INFO', 'Will wait 1 seconds to give the UI a moment to settle into the next screen (MFA/Password)');
  await sleep(200);

  // The interstitial screens the real package clears. Present so the app's
  // handling of them is exercised by default.
  log('INFO', "Blocking screen detected: \"Stay signed in?\" -> clicking \"Yes\"");
  await sleep(150);

  const scenario = password.toLowerCase();

  if (scenario === 'number') {
    log('WARN', 'Number Matching MFA detected ("Approve sign in request" screen).');
    await sleep(200);
    // The real line is a `step`, and the number is what the user has to approve
    // on their phone. Nothing is clicked here: the flow waits passively for the
    // element to disappear.
    log('STEP', '  Enter the number:  424242');
    await sleep(1500);
  } else if (scenario === 'mfa' || scenario === 'mfail') {
    log('WARN', 'MFA/Verification screen detected.');
    await sleep(200);
    const code = await readLine('Enter the verification code: ');
    await sleep(300);
    // Only one code is accepted, so a wrong code can be tested for real rather
    // than by asking for the `mfail` scenario. A malformed code fails the same
    // way, which is what the real login does.
    const accepted = scenario !== 'mfail' && code === '123456';
    if (!accepted) {
      log(
        'ERROR',
        'Authentication failed or cancelled:',
        new LoginError('Login Error (Verification): That code is incorrect.'),
      );
      log('DEBUG', 'Possible cause: incorrect credentials, MFA requirement, or selector change.');
      return reportFailure();
    }
  } else if (scenario === 'fail') {
    log(
      'ERROR',
      'Authentication failed or cancelled:',
      new LoginError('Login Error (Password): Your account or password is incorrect.'),
    );
    log('DEBUG', 'Possible cause: incorrect credentials, MFA requirement, or selector change.');
    return reportFailure();
  }

  if (scenario === 'nolog') {
    // The 0.1.9 failure mode: the app was reached, so the old code would have
    // logged a cheerful success with nothing usable behind it. The package now
    // reads the file back, finds it missing, and treats the login as failed.
    log('INFO', 'Saving authentication state...');
    log(
      'ERROR',
      `Login reached the authenticated interface but the auth file is not usable (missing): ${authFile} does not exist`,
    );
    log('ERROR', 'Treating this as a failed login: there is no usable state to save.');
    return reportFailure();
  }

  log('INFO', 'Saving authentication state...');
  if (authFile) {
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(
      authFile,
      JSON.stringify(
        { cookies: [{ name: 'fake', value: 'fake', domain: 'onenote.cloud.microsoft', expires: -1 }], origins: [] },
        null,
        2,
      ),
    );
    writeFileSync(
      authFile.replace(/\.json$/, '-meta.json'),
      JSON.stringify({ email, loginTime: new Date().toISOString() }, null, 2),
    );
  }
  log('SUCCESS', `Authentication successful! State saved to ${authFile}`);
}

/**
 * 0.1.9's closing line, and its exit code.
 *
 * Before 0.1.9 this package exited 0 here, which is what the POC's whole
 * "never trust the exit code" rule was built around. The line and the code are
 * both reproduced so the fake stays a faithful stand-in - the app still does not
 * *rely* on the code, and that is now belt and braces rather than a workaround.
 */
function reportFailure(): void {
  log('ERROR', 'login failed (exit 1). No usable auth state was saved. See the errors above.');
  process.exitCode = 1;
}

void main();