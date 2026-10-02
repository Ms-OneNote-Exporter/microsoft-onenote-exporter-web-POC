import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '../src/config';
import { EventHub, type RunnerEvent } from '../src/events';
import { JobBusyError, JobManager } from '../src/jobs';

/**
 * JobManager against real child processes.
 *
 * The behaviours under test - a prompt with no newline, SIGTERM to a process
 * group, a timeout that kills rather than hangs - are all properties of how a
 * process behaves. Mocking `spawn` would test the mock.
 */

const FAKE_DIR = resolve(__dirname, '../src/fake');

/**
 * `--import` with an absolute specifier.
 *
 * The bare name 'tsx' does not resolve, because a job's cwd is the session
 * directory and there is no node_modules above it - the loader has to be named
 * by absolute path to be found from inside a session. In the production image
 * this is not needed at all: the fake scripts are compiled to JS by tsc.
 */
const TSX_ARGS = ['--import', pathToFileURL(require.resolve('tsx')).href];
const GUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    port: 0,
    token: 'test-token',
    dataRoot: mkdtempSync(join(tmpdir(), 'msout-jobs-')),
    loginTimeoutMs: 20_000,
    exportTimeoutMs: 20_000,
    listTimeoutMs: 20_000,
    abortGraceMs: 2_000,
    ringSize: 500,
    fake: true,
    chromiumNoSandbox: false,
    ...overrides,
  };
}

interface Harness {
  hub: EventHub;
  jobs: JobManager;
  events: RunnerEvent[];
  lines: (kind: 'stdout' | 'stderr') => string[];
  ends: () => Extract<RunnerEvent, { kind: 'end' }>[];
  waitFor: (predicate: () => boolean, what: string) => Promise<void>;
  config: RunnerConfig;
}

const harnesses: Harness[] = [];

function harness(config = makeConfig()): Harness {
  const hub = new EventHub(config.ringSize);
  const jobs = new JobManager(hub, config);
  const events: RunnerEvent[] = [];
  hub.subscribe(GUID, (e) => events.push(e));

  const h: Harness = {
    config,
    hub,
    jobs,
    events,
    lines: (kind) =>
      events.filter((e): e is Extract<RunnerEvent, { kind: 'line' }> => e.kind === 'line' && e.stream === kind)
        .map((e) => e.text),
    ends: () => events.filter((e): e is Extract<RunnerEvent, { kind: 'end' }> => e.kind === 'end'),
    async waitFor(predicate, what) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timed out waiting for: ${what}\nlines:\n${JSON.stringify(h.lines('stdout'), null, 2)}\nstderr:\n${JSON.stringify(h.lines('stderr'), null, 2)}`);
    },
  };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    if (h.jobs.busy) h.jobs.abort(GUID);
    rmSync(h.config.dataRoot, { recursive: true, force: true });
  }
});

function fakeScript(name: 'login' | 'list' | 'export'): string {
  return join(FAKE_DIR, `${name}.ts`);
}

/**
 * Writes an auth.json for a session, creating the directory first.
 *
 * JobManager creates the directory tree when it starts a job, so a test that
 * wants an auth file beforehand has to make the directory itself - writing into
 * a path that does not exist yet fails for a reason that has nothing to do with
 * what the test is checking.
 */
function seedAuth(config: RunnerConfig, guid = GUID): string {
  const dir = join(config.dataRoot, guid);
  mkdirSync(dir, { recursive: true });
  const authFile = join(dir, 'auth.json');
  writeFileSync(authFile, '{}');
  return authFile;
}

describe('JobManager', () => {
  describe('concurrency', () => {
    it('refuses a second job while one is running', async () => {
      const h = harness();
      const authFile = seedAuth(h.config);

      h.jobs.start({
        guid: GUID,
        kind: 'export',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('export'), '--auth-file', authFile, '--output-dir', join(h.config.dataRoot, GUID, 'out'), '--non-interactive', '--notebook', 'Personal'],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });
      await h.waitFor(() => h.lines('stdout').some((l) => l.includes('Exporting:')), 'first export to start');

      expect(() =>
        h.jobs.start({
          guid: GUID,
          kind: 'login',
          command: process.execPath,
          args: ['-e', ''],
          cwd: h.config.dataRoot,
          timeoutMs: 1000,
        }),
      ).toThrow(JobBusyError);

      expect(h.jobs.describeActive()?.kind).toBe('export');
    });

    it('reports which job is blocking', async () => {
      const h = harness();
      const authFile = seedAuth(h.config);
      h.jobs.start({
        guid: GUID,
        kind: 'list',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('list'), '--auth-file', authFile],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });
      await h.waitFor(() => h.jobs.busy, 'list to start');
      const active = h.jobs.describeActive();
      expect(active).toMatchObject({ guid: GUID, kind: 'list' });
      expect(Date.parse(active!.since)).not.toBeNaN();
    });

    it('accepts a new job once the previous one has ended', async () => {
      const h = harness();
      const authFile = seedAuth(h.config);
      h.jobs.start({
        guid: GUID,
        kind: 'list',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('list'), '--auth-file', authFile],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });
      await h.waitFor(() => h.ends().length === 1, 'list to end');
      expect(h.jobs.busy).toBe(false);

      expect(() =>
        h.jobs.start({
          guid: GUID,
          kind: 'list',
          command: process.execPath,
          args: [...TSX_ARGS, fakeScript('list'), '--auth-file', authFile],
          cwd: h.config.dataRoot,
          timeoutMs: 20_000,
        }),
      ).not.toThrow();
    });
  });

  describe('line capture', () => {
    it('captures a successful login and publishes an end event', async () => {
      const h = harness();
      const authFile = join(h.config.dataRoot, GUID, 'auth.json');
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('login'), '--email', 'a@b.c', '--password', 'ok', '--auth-file', authFile],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });

      await h.waitFor(() => h.ends().length === 1, 'login to end');
      expect(h.lines('stdout').join('\n')).toContain('Authentication successful!');
      expect(h.ends()[0]!.result).toMatchObject({ kind: 'login', code: 0, aborted: false, timedOut: false });
    });

    it('captures the failure on stderr and still reports exit code 0', async () => {
      const h = harness();
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('login'), '--email', 'a@b.c', '--password', 'fail', '--auth-file', join(h.config.dataRoot, GUID, 'auth.json')],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });

      await h.waitFor(() => h.ends().length === 1, 'login to end');
      // The trap, end to end through a real process: the failure is only visible
      // in the log, and the exit code says success.
      expect(h.ends()[0]!.result.code).toBe(0);
      expect(h.lines('stderr').join('\n')).toContain('Authentication failed or cancelled:');
    });

    it('reports a non-zero exit code when the package uses one', async () => {
      const h = harness();
      const authFile = join(h.config.dataRoot, GUID, 'auth.json');
      h.jobs.start({
        guid: GUID,
        kind: 'export',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('export'), '--auth-file', authFile, '--non-interactive'],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });
      await h.waitFor(() => h.ends().length === 1, 'export to fail fast');
      expect(h.ends()[0]!.result.code).toBe(2);
    });

    it('reports a spawn failure instead of hanging', async () => {
      const h = harness();
      h.jobs.start({
        guid: GUID,
        kind: 'list',
        command: join(h.config.dataRoot, 'does-not-exist'),
        args: [],
        cwd: h.config.dataRoot,
        timeoutMs: 5000,
      });
      await h.waitFor(() => h.ends().length === 1, 'spawn failure to be reported');
      expect(h.ends()[0]!.result.spawnError).toBeTruthy();
      expect(h.jobs.busy).toBe(false);
    });

    it('creates the session directory tree before spawning', async () => {
      const h = harness();
      const base = join(h.config.dataRoot, GUID);
      expect(existsSync(base)).toBe(false);
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('login'), '--email', 'a@b.c', '--password', 'ok', '--auth-file', join(base, 'auth.json')],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });
      await h.waitFor(() => h.ends().length === 1, 'login to end');
      for (const sub of ['', '/logs', '/out', '/tmp', '/tmp/home']) {
        expect(existsSync(`${base}${sub}`)).toBe(true);
      }
    });

    it('points the child HOME and log dir inside the session', async () => {
      const h = harness();
      const base = join(h.config.dataRoot, GUID);
      // The fake writes the env it was given into its log output via HOME-based
      // paths; asserting on the env the runner sets is more direct.
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.HOME + "\\n" + process.env.ONENOTE_EXPORT_LOG_DIR + "\\n" + process.env.NO_COLOR)'],
        cwd: h.config.dataRoot,
        timeoutMs: 5000,
      });
      await h.waitFor(() => h.ends().length === 1, 'env probe to end');
      const out = h.lines('stdout');
      expect(out).toContain(`${base}/tmp/home`);
      expect(out).toContain(`${base}/logs`);
      expect(out).toContain('1');
    });
  });

  describe('MFA over stdin', () => {
    it('surfaces the code prompt even though it has no trailing newline', async () => {
      const h = harness();
      const authFile = join(h.config.dataRoot, GUID, 'auth.json');
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('login'), '--email', 'a@b.c', '--password', 'mfa', '--auth-file', authFile],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });

      await h.waitFor(() => h.lines('stdout').some((l) => l.includes('Enter the verification code:')), 'the MFA prompt to appear');
      expect(h.jobs.acceptsStdin(GUID)).toBe(true);
      expect(h.jobs.sendStdin(GUID, '123456')).toBe(true);

      await h.waitFor(() => h.ends().length === 1, 'login to end after the code');
      expect(existsSync(authFile)).toBe(true);
    });

    it('rejects input that is not a short code', async () => {
      const h = harness();
      const authFile = join(h.config.dataRoot, GUID, 'auth.json');
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('login'), '--email', 'a@b.c', '--password', 'mfa', '--auth-file', authFile],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });
      await h.waitFor(() => h.jobs.acceptsStdin(GUID), 'login to wait for input');

      // Newlines and control characters could drive the child's readline beyond
      // a single answer; shell metacharacters have no business here at all.
      expect(h.jobs.sendStdin(GUID, '123456\nrm -rf /')).toBe(false);
      expect(h.jobs.sendStdin(GUID, '$(whoami)')).toBe(false);
      expect(h.jobs.sendStdin(GUID, 'x'.repeat(65))).toBe(false);
      expect(h.jobs.sendStdin(GUID, '123456')).toBe(true);
    });

    it('refuses input when no login is waiting', () => {
      const h = harness();
      expect(h.jobs.sendStdin(GUID, '123456')).toBe(false);
      expect(h.jobs.acceptsStdin(GUID)).toBe(false);
    });
  });

  describe('abort', () => {
    it('kills a running job and reports it as aborted', async () => {
      const h = harness(makeConfig({ abortGraceMs: 1_000 }));
      const authFile = seedAuth(h.config);
      h.jobs.start({
        guid: GUID,
        kind: 'export',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('export'), '--auth-file', authFile, '--output-dir', join(h.config.dataRoot, GUID, 'out'), '--non-interactive', '--notebook', 'Personal'],
        cwd: h.config.dataRoot,
        timeoutMs: 60_000,
      });
      await h.waitFor(() => h.lines('stdout').filter((l) => l.includes('Exporting:')).length >= 2, 'a couple of pages');

      expect(h.jobs.abort(GUID)).toBe(true);
      await h.waitFor(() => h.ends().length === 1, 'the job to end');
      expect(h.ends()[0]!.result.aborted).toBe(true);
      // Whatever was written before the interrupt is still on disk: partial
      // output is the reason abort preserves the directory.
      expect(existsSync(join(h.config.dataRoot, GUID, 'out'))).toBe(true);
      expect(h.jobs.busy).toBe(false);
    });

    it('escalates to SIGKILL when SIGTERM is ignored', async () => {
      const h = harness(makeConfig({ abortGraceMs: 300 }));
      // A process that traps SIGTERM and keeps running, which is the case the
      // grace period exists for.
      h.jobs.start({
        guid: GUID,
        kind: 'export',
        command: process.execPath,
        args: [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('Exporting: trapped\\n'); setInterval(() => {}, 1000);",
        ],
        cwd: h.config.dataRoot,
        timeoutMs: 60_000,
      });
      await h.waitFor(() => h.lines('stdout').some((l) => l.includes('trapped')), 'the trap to be installed');

      expect(h.jobs.abort(GUID)).toBe(true);
      await h.waitFor(() => h.ends().length === 1, 'the job to be killed');
      expect(h.ends()[0]!.result.aborted).toBe(true);
      expect(h.ends()[0]!.result.durationMs).toBeLessThan(30_000);
    });

    it('returns false when there is nothing to abort', () => {
      const h = harness();
      expect(h.jobs.abort(GUID)).toBe(false);
    });

    it('does not abort another session job', async () => {
      const h = harness();
      const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      h.jobs.start({
        guid: other,
        kind: 'export',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: h.config.dataRoot,
        timeoutMs: 60_000,
      });
      await h.waitFor(() => h.jobs.busy, 'the other job to start');
      expect(h.jobs.abort(GUID)).toBe(false);
      expect(h.jobs.busy).toBe(true);
      h.jobs.abort(other);
    });
  });

  describe('timeouts', () => {
    it('kills a job that exceeds its timeout rather than waiting on it forever', async () => {
      // This is what stands in for the packages swallowing MFA failures
      // internally: without it, a login blocked on an unanswered prompt would
      // hold the only slot in the runner for the full LOGIN_TIMEOUT_MS with
      // nothing in the log to show for it.
      const h = harness(makeConfig({ loginTimeoutMs: 400, abortGraceMs: 500 }));
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("Enter the verification code: "); setInterval(() => {}, 1000);'],
        cwd: h.config.dataRoot,
        timeoutMs: 400,
      });

      await h.waitFor(() => h.ends().length === 1, 'the timeout to fire');
      expect(h.ends()[0]!.result.timedOut).toBe(true);
      expect(h.ends()[0]!.result.aborted).toBe(false);
      expect(h.lines('stderr').join('\n')).toContain('exceeded its timeout');
      expect(h.jobs.busy).toBe(false);
    });

    it('does not fire on a job that finishes in time', async () => {
      const h = harness(makeConfig({ loginTimeoutMs: 20_000 }));
      const authFile = join(h.config.dataRoot, GUID, 'auth.json');
      h.jobs.start({
        guid: GUID,
        kind: 'login',
        command: process.execPath,
        args: [...TSX_ARGS, fakeScript('login'), '--email', 'a@b.c', '--password', 'ok', '--auth-file', authFile],
        cwd: h.config.dataRoot,
        timeoutMs: 20_000,
      });
      await h.waitFor(() => h.ends().length === 1, 'login to end');
      expect(h.ends()[0]!.result.timedOut).toBe(false);
    });
  });
});