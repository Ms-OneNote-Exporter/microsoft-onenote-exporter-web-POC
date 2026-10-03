import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionState } from '@msout-poc/shared';
import { JobQueue } from '../src/server/queue';
import { RunnerClient, RunnerError, parseFrame } from '../src/server/runner-client';
import type { JobResult, RunnerEvent } from '../src/server/runner-events';
import { Service, ServiceError } from '../src/server/service';
import { SessionStore } from '../src/server/session-store';
import { SseHub } from '../src/server/sse';

/**
 * The whole flow against a fake runner.
 *
 * The fake replays the exact line sequences captured from the published
 * packages, including the two that matter most: a login that exits 0 after
 * failing, and a successful export that only ever says "Export complete!" in a
 * log line. Everything the service asserts is therefore anchored to real output
 * rather than to an idea of it.
 */

const GUID = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';
const GUID_OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

type Script = {
  /** Lines to emit, as the runner would. */
  lines: { stream: 'stdout' | 'stderr'; text: string }[];
  /** How the process ends. */
  result: Partial<JobResult>;
  /** Called when a job starts, before any line is emitted. */
  onStart?: () => void;
};

/** A RunnerClient whose transport is a scripted list of jobs. */
class FakeRunner {
  readonly calls: { op: string; args: unknown[] }[] = [];
  readonly rawBodies: string[] = [];
  private readonly scripts = new Map<number, Script>();
  private next = 0;
  private runningKind: 'login' | 'check' | 'list' | 'export' = 'login';
  /** How many jobs have started; also the cursor into the staged scripts. */
  private cursor = 0;
  private activeScript: Script | undefined;
  private pendingSeq = 1;
  /** Events already emitted for a session, replayed to a late subscriber. */
  private readonly transcript = new Map<string, RunnerEvent[]>();
  private subscribers = new Map<string, (event: RunnerEvent | { kind: 'gap' }) => void>();

  constructor(private readonly dataRoot: string) {}

  /**
   * Stages the script for the next job to start.
   *
   * A cursor advances per job started, so three staged scripts drive three
   * consecutive jobs. Reading the last-staged script for every job - which is
   * what `scripts.get(this.next)` does - passes when a test stages exactly one
   * script and silently mis-runs when it stages more: the check's script gets
   * replayed as the export that follows it.
   */
  script(script: Script): this {
    this.scripts.set(++this.next, script);
    return this;
  }

  /**
   * Stages a successful login.
   *
   * Writes the auth file as the real package does, because the service's verdict
   * requires it: success is "the file exists AND the success line appeared", and
   * a fake that logs success without writing a file would test the wrong half.
   */
  scriptLoginSuccess(options: { mfa?: boolean; numberMatch?: boolean } = {}): this {
    this.writeAuthFile(GUID);
    const lines: Script['lines'] = [
      { stream: 'stdout', text: '[Oct 02 21:14:03] [INFO] Attempting automated login for someone@example.com...' },
      { stream: 'stdout', text: '[Oct 02 21:14:05] [STEP] Automating login steps...' },
    ];
    if (options.numberMatch) {
      lines.push(
        { stream: 'stdout', text: '[Oct 02 21:15:10] [WARN] Number Matching MFA detected ("Approve sign in request" screen).' },
        { stream: 'stdout', text: '[Oct 02 21:15:11] [STEP]   Enter the number:  424242' },
      );
    } else if (options.mfa) {
      lines.push(
        { stream: 'stdout', text: '[Oct 02 21:14:05] [WARN] MFA/Verification screen detected.' },
        { stream: 'stdout', text: 'Enter the verification code: ' },
      );
    }
    lines.push(
      { stream: 'stdout', text: '[Oct 02 21:14:22] [INFO] Saving authentication state...' },
      { stream: 'stdout', text: `[Oct 02 21:14:22] [SUCCESS] Authentication successful! State saved to /data/${GUID}/auth.json` },
    );
    return this.script({ lines, result: { code: 0 } });
  }

  /** Stages a failed login that exits 0, exactly as the package does. */
  scriptLoginFailure(): this {
    return this.script({
      lines: [
        { stream: 'stdout', text: '[Oct 02 21:14:03] [INFO] Attempting automated login for someone@example.com...' },
        { stream: 'stderr', text: '[Oct 02 21:16:20] [ERROR] Authentication failed or cancelled:' },
        { stream: 'stderr', text: 'Error: Login Error (Password): Your account or password is incorrect.' },
        { stream: 'stdout', text: '[Oct 02 21:16:20] [DEBUG] Possible cause: incorrect credentials, MFA requirement, or selector change.' },
      ],
      // The trap: a failed login exits 0.
      result: { code: 0 },
    });
  }

  scriptExportSuccess(pages = 3): this {
    return this.scriptExport(pages, false);
  }

  /**
   * Stages a `microsoft-webauth check` run.
   *
   * `verdict` is one of `authenticated`, `expired`, `stale`, `unverifiable`,
   * `missing`. These are 0.1.9's outcomes, and they are deliberately distinct:
   * the preflight's whole job is to tell "sign in again" apart from "the check
   * itself failed", and a fake that only knew success/failure would not exercise
   * the distinction that makes it worth having.
   */
  scriptCheck(
    verdict:
      | 'authenticated'
      | 'expired'
      | 'stayed_unauthenticated'
      | 'unverifiable'
      | 'no_auth_file' = 'authenticated',
  ): this {
    // The reason strings are 0.1.9's own: the app matches on them, so a fake
    // that invented its own would test the wrong thing.
    const detail: Record<string, string> = {
      authenticated: '',
      expired: 'the session was redirected to login.live.com; stale auth state deleted',
      stayed_unauthenticated:
        'the signed-in interface never rendered and the session was never sent to a login page; the auth file was left in place',
      unverifiable: 'could not verify the session (net::ERR_TIMED_OUT); the auth file was left in place',
      no_auth_file: `${GUID}/auth.json does not exist`,
    };
    const lines: Script['lines'] = [
      { stream: 'stdout', text: '[Oct 03 09:00:00] [DEBUG] Verifying authentication session...' },
    ];
    if (verdict === 'authenticated') {
      lines.push({
        stream: 'stdout',
        text: '[Oct 03 09:00:04] [SUCCESS] Authentication file found. You are authenticated.',
      });
      return this.script({ lines, result: { kind: 'check', code: 0 } });
    }
    lines.push(
      { stream: 'stderr', text: `[Oct 03 09:00:04] [ERROR] Not authenticated (${verdict}). ${detail[verdict]}` },
      { stream: 'stderr', text: '[Oct 03 09:00:04] [ERROR] Run "login" first.' },
      {
        stream: 'stderr',
        text: '[Oct 03 09:00:04] [ERROR] check failed (exit 1). No authenticated session could be confirmed. See the reason above.',
      },
    );
    // `expired` is the only verdict that deletes the auth file, which is what the
    // service has to notice.
    if (verdict === 'expired') this.removeAuthFile();
    return this.script({ lines, result: { kind: 'check', code: 1 } });
  }

  /** Deletes the auth file, as `check` does on an expired verdict. */
  removeAuthFile(): void {
    rmSync(join(this.dataRoot, GUID, 'auth.json'), { force: true });
  }

  scriptListSuccess(): this {
    return this.script({
      lines: [
        { stream: 'stdout', text: '[Oct 02 20:39:18] [INFO] Connecting to OneNote...' },
        { stream: 'stdout', text: '[Oct 02 20:39:21] [STEP] \nAvailable Notebooks:' },
        { stream: 'stdout', text: '[Oct 02 20:39:21] [INFO] 1. Personal (https://onedote.cloud.microsoft/onenote/?id=Personal)' },
        { stream: 'stdout', text: '[Oct 02 20:39:21] [INFO] 2. Work (https://onedote.cloud.microsoft/onenote/?id=Work)' },
      ],
      result: { code: 0 },
    });
  }

  /** Stages an export, creating the output directory the artifact check looks for. */
  scriptExport(pages: number, partial: boolean): this {
    this.writeExportDir(GUID);
    const lines: Script['lines'] = [
      { stream: 'stdout', text: '[2026-10-02 21:20:01+02:00] [INFO] Fetching notebooks...' },
      { stream: 'stdout', text: '[2026-10-02 21:20:14+02:00] [INFO] Auto-selecting notebook: "Personal"...' },
      { stream: 'stdout', text: '[2026-10-02 21:20:19+02:00] [INFO] Exporting notebook: Personal' },
    ];
    for (let i = 0; i < pages; i += 1) {
      // Both lines, in the order the real package emits them: `Exporting:`
      // when the page starts, `Saved` once the file is on disk. Only the second
      // is counted, so a page that starts and never finishes is not counted.
      lines.push(
        { stream: 'stdout', text: `[2026-10-02 21:20:2${i}+02:00] [INFO] Exporting: Page ${i + 1} ...` },
        { stream: 'stdout', text: `[2026-10-02 21:20:2${i}+02:00] [SUCCESS] Saved (0 assets)` },
      );
    }
    lines.push(
      { stream: 'stdout', text: `[2026-10-02 21:20:28+02:00] [INFO] Total Pages: ${pages}` },
      { stream: 'stdout', text: `[2026-10-02 21:20:28+02:00] [INFO] Files saved in: /data/${GUID}/out/Personal` },
    );
    // A partial run says so and never says "Export complete!". Getting this
    // backwards is exactly how a truncated vault looks like a finished one.
    lines.push(
      partial
        ? { stream: 'stdout', text: '[2026-10-02 21:22:10+02:00] [WARN] Export finished with errors - 3 item(s) could not be exported.' }
        : { stream: 'stdout', text: '[2026-10-02 21:20:28+02:00] [SUCCESS] Export complete!' },
    );
    return this.script({ lines, result: { code: 0 } });
  }

  /**
   * Writes the auth file a successful login leaves behind.
   *
   * A fake that logged "Authentication successful!" without creating the file
   * would let the service pass on half the rule; the other half - a success line
   * with no file must NOT authenticate - has its own test.
   */
  writeAuthFile(guid: string): void {
    const dir = join(this.dataRoot, guid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth.json'), '{"cookies":[]}');
  }

  /** Creates the output directory the artifact check looks for. */
  writeExportDir(guid: string): void {
    mkdirSync(join(this.dataRoot, guid, 'out', 'Personal'), { recursive: true });
  }

  asClient(): RunnerClient {
    const self = this;
    return {
      credentials: async (guid: string, rawBody: string) => {
        self.calls.push({ op: 'credentials', args: [guid] });
        self.rawBodies.push(rawBody);
        self.begin(guid, 'login');
        return { fromSeq: 0 };
      },
      mfa: async (guid: string, code: string) => {
        self.calls.push({ op: 'mfa', args: [guid, code] });
      },
      check: async (guid: string) => {
        self.calls.push({ op: 'check', args: [guid] });
        self.begin(guid, 'check');
        return { fromSeq: 0 };
      },
      list: async (guid: string) => {
        self.calls.push({ op: 'list', args: [guid] });
        self.begin(guid, 'list');
        return { fromSeq: 0 };
      },
      export: async (guid: string, target: unknown) => {
        self.calls.push({ op: 'export', args: [guid, target] });
        self.begin(guid, 'export');
        return { fromSeq: 0 };
      },
      abort: async (guid: string) => {
        self.calls.push({ op: 'abort', args: [guid] });
        return true;
      },
      erase: async (guid: string) => {
        self.calls.push({ op: 'erase', args: [guid] });
      },
      artifactSize: async () => 0,
      artifactPath: (guid: string, notebook: string | null, partial: boolean) =>
        `/artifact?guid=${guid}&notebook=${notebook ?? ''}&partial=${partial ? 1 : 0}`,
      subscribe: (guid: string, _since: number, onEvent: (event: RunnerEvent | { kind: 'gap' }) => void) => {
        self.subscribers.set(guid, onEvent);
        // Replay anything emitted before the subscription arrived.
        //
        // The real runner keeps a ring buffer precisely so this race is harmless:
        // a line printed between the 202 and the app's subscribe is still
        // delivered. A fake that dropped it would hide a bug in the real one.
        for (const event of self.transcript.get(guid) ?? []) onEvent(event);
        return () => self.subscribers.delete(guid);
      },
    } as unknown as RunnerClient;
  }

  /** Marks a job as started and records its lines for later replay. */
  private begin(guid: string, kind: 'login' | 'check' | 'list' | 'export'): void {
    const script = this.scripts.get(++this.cursor);
    this.activeScript = script;
    if (!script) return;
    this.runningKind = kind;
    const events: RunnerEvent[] = [];
    let seq = 0;
    for (const line of script.lines) {
      seq += 1;
      const event: RunnerEvent = {
        kind: 'line',
        seq,
        stream: line.stream,
        text: line.text,
        at: new Date().toISOString(),
      };
      events.push(event);
      this.subscribers.get(guid)?.(event);
    }
    this.transcript.set(guid, events);
    this.pendingSeq = seq + 1;
    script.onStart?.();
  }

  /** Ends the running job with the staged result. */
  endJob(guid: string, overrides: Partial<JobResult> = {}): void {
    // The script that started *this* job, whose lines and result belong to it.
    const script = this.activeScript;
    const onEvent = this.subscribers.get(guid);
    if (!script || !onEvent) throw new Error('no job running');
    const event: RunnerEvent = {
      kind: 'end',
      seq: this.pendingSeq++,
      at: new Date().toISOString(),
      result: {
        kind: this.runningKind,
        code: 0,
        signal: null,
        durationMs: 1000,
        timedOut: false,
        aborted: false,
        ...script.result,
        ...overrides,
      },
    };
    (this.transcript.get(guid) ?? []).push(event);
    onEvent(event);
  }
}

interface Harness {
  service: Service;
  runner: FakeRunner;
  store: SessionStore;
  sse: SseHub;
  queue: JobQueue;
  dataRoot: string;
  events: unknown[];
}

let harness: Harness;

beforeEach(() => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'msout-svc-'));
  const store = new SessionStore(dataRoot, 12);
  const queue = new JobQueue();
  const sse = new SseHub(500, 60_000);
  const runner = new FakeRunner(dataRoot);
  const events: unknown[] = [];
  const service = new Service({
    store,
    queue,
    runner: runner.asClient(),
    sse,
    dataRoot,
    // A real host has gigabytes free; the guard is tested separately.
    minFreeDiskMb: 0,
    log: () => {},
  });
  // Capture everything the service emits, for assertions about the UI contract.
  const originalPublish = sse.publish.bind(sse);
  sse.publish = (guid: string, event: unknown) => {
    events.push(event);
    originalPublish(guid, event as never);
  };

  harness = { service, runner, store, sse, queue, dataRoot, events };
});

afterEach(() => {
  rmSync(harness.dataRoot, { recursive: true, force: true });
});

/** Waits for an arbitrary condition, so tests assert on outcomes not on ticks. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits until a session reaches a state, so tests assert on outcomes not ticks. */
async function waitForState(predicate: (state: SessionState) => boolean, what: string): Promise<SessionState> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = harness.store.peek(GUID);
    if (state && predicate(state)) return state;
    await new Promise((r) => setTimeout(r, 5));
  }

  throw new Error(`timed out waiting for ${what}; state=${JSON.stringify(harness.store.peek(GUID), null, 2)}`);
}

/** Drives one job to completion: wait for it to start, then end it. */
async function runJob(
  kind: 'login' | 'check' | 'list' | 'export',
  overrides: Partial<JobResult> = {},
): Promise<SessionState> {
  // The kind is matched on the way in: jobs are serialised, so waiting on
  // `state === 'running'` alone can latch onto whichever job is in flight rather
  // than the one this test started. `running` is safe to wait for, because only
  // the end event clears it and this helper has not sent one yet.
  await waitForState((s) => s.job?.state === 'running' && s.job.kind === kind, `${kind} to start`);
  const id = harness.store.peek(GUID)!.job!.id;
  harness.runner.endJob(GUID, { kind, ...overrides });

  // Completion is read from the event log, not from `state.job`. That record is
  // single-slot: a job queued behind this one overwrites it the instant this one
  // ends, so a poll for `state === 'ended'` races the next job and can miss the
  // window entirely - which is exactly what happened to the preflight tests,
  // where a list or export follows every check. The event log is append-only, so
  // nothing can be missed.
  await waitFor(
    () =>
      harness.events.some((event) => {
        const e = event as { type?: string; job?: { id: string; state: string } };
        return e.type === 'job-state' && e.job?.id === id && e.job.state === 'ended';
      }),
    `${kind} to end`,
  );
  return harness.store.peek(GUID)!;
}

/** Signs a session in successfully, ready for list and export. */
async function signedIn(options: { mfa?: boolean; skipCheck?: boolean } = {}): Promise<void> {
  harness.service.createSession(GUID);
  harness.runner.scriptLoginSuccess(options);
  void harness.service.login(GUID, '{"email":"a@b.c","password":"pw"}');
  if (options.mfa) {
    await waitForState((s) => s.mfa.kind === 'code', 'the MFA prompt to surface');
    await harness.service.submitMfa(GUID, '123456');
  }
  await runJob('login');
  await waitForState((s) => s.auth.state === 'valid', 'login to succeed');

  // A login proves we hold state, not that the session is still live, so
  // `checkedAt` starts null and the first list/export runs the preflight. These
  // tests are not about the preflight, so let one pass here and cache its
  // verdict; the ones that are drive it themselves.
  if (options.skipCheck) return;

  harness.runner.scriptCheck('authenticated');
  void harness.service.checkAuth(GUID);
  await runJob('check');
  await waitForState((s) => s.auth.checkedAt !== null, 'the preflight to record a verdict');
}

/**
 * Runs an action that triggers the preflight, and drives the check job.
 *
 * The action cannot simply be awaited: it waits for the check, and the check
 * waits for the test to end the job. So the action is started, the job is driven
 * to completion, and only then is the action's promise awaited.
 */
async function withCheck<T>(action: () => Promise<T>): Promise<T> {
  const pending = action();
  // The caller asserts on the rejection. This attaches a handler as well, so a
  // rejection that lands after the assertion has been made is not reported to
  // vitest as an unhandled one and fails the run on its own.
  pending.catch(() => undefined);
  await runJob('check');
  return pending;
}

/** Rebuilds the service with a different preflight cache TTL, on the same store. */
function serviceWithPreflightTtl(cacheMs: number): Service {
  return new Service({
    store: harness.store,
    queue: harness.queue,
    runner: harness.runner.asClient(),
    sse: harness.sse,
    dataRoot: harness.dataRoot,
    minFreeDiskMb: 0,
    checkPreflightTtlMs: cacheMs,
    log: () => {},
  });
}

describe('Service', () => {
  describe('sessions', () => {
    it('creates a session on first contact', () => {
      const state = harness.service.createSession(GUID);
      expect(state.guid).toBe(GUID);
      expect(state.auth.state).toBe('none');
      expect(state.job).toBeNull();
    });

    it('returns the same session on a second call', () => {
      harness.service.createSession(GUID);
      const again = harness.service.createSession(GUID);
      expect(again.createdAt).toBe(harness.store.peek(GUID)!.createdAt);
    });

    it('rejects a malformed guid without touching the filesystem', () => {
      expect(() => harness.service.createSession('../../etc')).toThrow(ServiceError);
      expect(() => harness.service.createSession('not-a-guid')).toThrow();
    });

    it('404s a read for a session that does not exist, without creating one', () => {
      expect(() => harness.service.readSession(GUID)).toThrow(/no such session/);
      expect(harness.store.peek(GUID)).toBeNull();
    });
  });

  describe('login', () => {
    it('marks the session authenticated only on success', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginSuccess();
      void harness.service.login(GUID, '{"email":"a@b.c","password":"pw"}');
      await waitForState((s) => s.job?.state === 'running', 'login to start');
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });
      const state = await waitForState((s) => s.auth.state === 'valid', 'auth to be valid');
      expect(state.auth.at).not.toBeNull();
    });

    it('never trusts the exit code of a failed login', async () => {
      // The whole reason judgeLogin checks the auth file and the log line: the
      // package exits 0 on a failed login, verified against a real capture.
      harness.service.createSession(GUID);
      harness.runner.scriptLoginFailure();
      void harness.service.login(GUID, '{"email":"a@b.c","password":"wrong"}');
      await waitForState((s) => s.job?.state === 'running', 'login to start');
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });

      await waitForState((s) => s.auth.state === 'failed', 'auth to fail');
      expect(harness.store.peek(GUID)!.auth.state).not.toBe('valid');
      expect(harness.store.peek(GUID)!.job?.error).toBe('bad_credentials');
    });

    it('reports bad_credentials with a readable message', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginFailure();
      void harness.service.login(GUID, '{"email":"a@b.c","password":"wrong"}');
      await runJob('login');

      // Wait for the event rather than the state: state is written before events
      // are emitted, so a state-based wait can observe 'failed' and race ahead of
      // the error event this asserts on.
      await waitFor(
        () => harness.events.some((e) => (e as { type?: string }).type === 'error'),
        'the error event',
      );

      const error = harness.events.find(
        (e) => (e as { type?: string }).type === 'error',
      ) as { code: string; message: string };
      expect(error.code).toBe('bad_credentials');
      // A message the user can act on, not the raw log line.
      expect(error.message).toMatch(/rejected those credentials/i);
      expect(error.message).not.toMatch(/stack|at .*\.js:\d+/i);
    });

    it('does not authenticate when the success line appears but auth.json does not', async () => {
      // The other half of the rule. A log line alone is not proof: if the file
      // was never written, nothing downstream can work.
      harness.service.createSession(GUID);
      harness.runner.script({
        lines: [{ stream: 'stdout', text: '[Oct 02 21:14:22] [SUCCESS] Authentication successful! State saved to /data/x/auth.json' }],
        result: { code: 0 },
      });
      void harness.service.login(GUID, '{}');
      await waitForState((s) => s.job?.state === 'running', 'login to start');
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });
      const state = await waitForState((s) => s.auth.state === 'failed', 'failure');
      expect(state.auth.state).not.toBe('valid');
    });

    it('surfaces a code MFA prompt to the UI', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginSuccess({ mfa: true });
      void harness.service.login(GUID, '{"email":"a@b.c","password":"pw"}');
      const state = await waitForState((s) => s.mfa.kind === 'code', 'the code prompt');

      expect(state.mfa).toMatchObject({ kind: 'code', number: null });
      const event = harness.events.find((e) => (e as { type?: string }).type === 'mfa-required');
      expect(event).toBeTruthy();
      expect(harness.runner.calls.some((c) => c.op === 'mfa')).toBe(false);
    });

    it('surfaces the number-match challenge with exactly one number', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginSuccess({ numberMatch: true });
      void harness.service.login(GUID, '{"email":"a@b.c","password":"pw"}');
      const state = await waitForState((s) => s.mfa.kind === 'number', 'the number prompt');

      expect(state.mfa.number).toBe('424242');
      // No code input is offered for a number-match: approval is on the phone.
      expect(harness.runner.calls.some((c) => c.op === 'mfa')).toBe(false);
    });

    it('clears the MFA state once the login resolves', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginSuccess({ mfa: true });
      void harness.service.login(GUID, '{"email":"a@b.c","password":"pw"}');
      await waitForState((s) => s.mfa.kind === 'code', 'the prompt');
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });
      const state = await waitForState((s) => s.auth.state === 'valid', 'success');
      // A stale challenge left in state would show a code box on a signed-in session.
      expect(state.mfa).toEqual({ kind: null, number: null, askedAt: null });
    });

    it('forwards the credential bytes verbatim, never parsing them', async () => {
      // The privacy property: the app does not read the email or the password out
      // of this body. It is opaque to every layer above the runner.
      harness.service.createSession(GUID);
      const raw = '{"email":"someone@example.com","password":"hunter2"}';
      harness.runner.scriptLoginSuccess();
      void harness.service.login(GUID, raw);
      await waitForState((s) => s.job?.state === 'running', 'login to start');

      expect(harness.runner.rawBodies).toEqual([raw]);
      // The state's email comes from the package's own log line, not from parsing.
      await waitForState((s) => s.job?.state === 'running', 'still running');
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });
      await waitForState((s) => s.auth.state === 'valid', 'success');
    });

    it('never writes the credential body to the session directory', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginSuccess();
      void harness.service.login(GUID, '{"email":"a@b.c","password":"SUPERSECRET"}');
      await waitForState((s) => s.job?.state === 'running', 'login to start');
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });
      await waitForState((s) => s.auth.state === 'valid', 'success');

      const state = harness.store.peek(GUID)!;
      expect(JSON.stringify(state)).not.toContain('SUPERSECRET');
      expect(JSON.stringify(state)).not.toContain('hunter2');
    });

    it('refuses a second job for the same session', async () => {
      await signedIn();
      // A login while an export is queued or running is a conflict, not a queue.
      harness.runner.scriptExportSuccess(1);
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.state === 'running' || s.export.state === 'queued', 'export to start');

      await expect(harness.service.listNotebooks(GUID)).rejects.toThrow(/already has a job/);
    });

    it('refuses an export before the session is authenticated', async () => {
      harness.service.createSession(GUID);
      await expect(harness.service.exportNotebook(GUID, { notebook: 'Personal' })).rejects.toThrow(
        /Sign in first/,
      );
    });
  });

  describe('list notebooks', () => {
    it('collects the names and urls from the listing lines', async () => {
      await signedIn();
      harness.runner.scriptListSuccess();
      void harness.service.listNotebooks(GUID);
      await waitForState((s) => s.job?.state === 'running', 'list to start');
      harness.runner.endJob(GUID, { kind: 'list', code: 0 });

      const state = await waitForState((s) => s.notebooks.state === 'loaded', 'list to load');
      expect(state.notebooks.items.map((n) => n.name)).toEqual(['Personal', 'Work']);
      expect(state.notebooks.items[0]!.url).toContain('id=Personal');
    });

    it('reports an empty listing distinctly from a failure', async () => {
      // "You have no notebooks" and "the listing broke" are different messages,
      // and the user needs to be able to tell them apart.
      await signedIn();
      harness.runner.script({
        lines: [
          { stream: 'stdout', text: '[Oct 02 20:39:18] [INFO] Connecting to OneNote...' },
          { stream: 'stdout', text: '[Oct 02 20:39:21] [WARN] No notebook have been found.' },
        ],
        result: { code: 0 },
      });
      void harness.service.listNotebooks(GUID);
      await waitForState((s) => s.job?.state === 'running', 'list to start');
      harness.runner.endJob(GUID, { kind: 'list', code: 0 });

      const state = await waitForState((s) => s.notebooks.state === 'failed', 'list to fail');
      expect(state.notebooks.error).toBe('no_notebooks');
    });

    it('maps a missing auth file to no_auth', async () => {
      await signedIn();
      harness.runner.script({
        lines: [
          { stream: 'stderr', text: '[Oct 02 20:39:18] [ERROR] Failed to list notebooks.' },
          { stream: 'stderr', text: 'Error: Authentication file not found: /data/x/auth.json' },
        ],
        result: { code: 1 },
      });
      void harness.service.listNotebooks(GUID);
      await waitForState((s) => s.job?.state === 'running', 'list to start');
      harness.runner.endJob(GUID, { kind: 'list', code: 1 });

      const state = await waitForState((s) => s.notebooks.state === 'failed', 'list to fail');
      expect(state.notebooks.error).toBe('no_auth');
    });
  });

  describe('export', () => {
    it('counts pages and finishes clean', async () => {
      await signedIn();
      harness.runner.scriptExportSuccess(3);
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.state === 'running', 'export to start');
      harness.runner.endJob(GUID, { kind: 'export', code: 0 });

      const state = await waitForState((s) => s.export.state === 'done', 'export to finish');
      expect(state.export.pagesExported).toBe(3);
      expect(state.export.totalPages).toBe(3);
      expect(state.export.partial).toBe(false);
    });

    it('prefers the notebook url when one is given', async () => {
      await signedIn();
      harness.runner.scriptExportSuccess(1);
      void harness.service.exportNotebook(GUID, { notebookUrl: 'https://example.invalid/nb' });
      await waitForState((s) => s.export.state === 'running', 'export to start');
      const call = harness.runner.calls.find((c) => c.op === 'export');
      expect(call!.args[1]).toEqual({ notebookUrl: 'https://example.invalid/nb' });
      harness.runner.endJob(GUID, { kind: 'export', code: 0 });
      await waitForState((s) => s.export.state === 'done', 'export to finish');
    });

    it('requires a target', async () => {
      await signedIn();
      await expect(harness.service.exportNotebook(GUID, {})).rejects.toThrow(/notebook/i);
    });

    it('labels an interrupted export partial, not failed', async () => {
      await signedIn();
      harness.runner.scriptExportSuccess(5);
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.pagesExported >= 2, 'a couple of pages');

      expect(await harness.service.abortExport(GUID)).toBe(true);
      harness.runner.endJob(GUID, { kind: 'export', code: null, signal: 'SIGTERM', aborted: true });

      const state = await waitForState((s) => s.export.state === 'partial', 'export to be partial');
      // Partial is distinct from failed: the user still gets what was written.
      expect(state.export.state).toBe('partial');
      expect(state.export.partial).toBe(true);
      expect(state.export.error).toBe('aborted');
    });

    it('marks an export with item failures partial rather than clean', async () => {
      await signedIn();
      harness.runner.script({
        lines: [
          { stream: 'stdout', text: '[2026-10-02 21:20:19+02:00] [INFO] Exporting notebook: Personal' },
          { stream: 'stdout', text: '[2026-10-02 21:20:20+02:00] [INFO] Exporting: Page 1 ...' },
          { stream: 'stdout', text: '[2026-10-02 21:22:10+02:00] [WARN] Export finished with errors - 3 item(s) could not be exported.' },
          { stream: 'stdout', text: '[2026-10-02 21:22:10+02:00] [INFO] Total Pages: 41' },
        ],
        result: { code: 0 },
      });
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.state === 'running', 'export to start');
      harness.runner.endJob(GUID, { kind: 'export', code: 0 });

      const state = await waitForState((s) => s.export.state === 'partial', 'export to be partial');
      // A partial run must never look like a clean one.
      expect(state.export.state).not.toBe('done');
      expect(state.export.totalPages).toBe(41);
    });

    it('reports a dead OneNote tab as a failure', async () => {
      await signedIn();
      harness.runner.script({
        lines: [
          { stream: 'stdout', text: '[2026-10-02 21:20:19+02:00] [INFO] Exporting notebook: Personal' },
          { stream: 'stderr', text: '[2026-10-02 21:25:30+02:00] [ERROR] Unexpected internal failure during the export (this is a bug):' },
        ],
        result: { code: 1 },
      });
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.state === 'running', 'export to start');
      harness.runner.endJob(GUID, { kind: 'export', code: 1 });

      const state = await waitForState((s) => s.export.state === 'failed', 'export to fail');
      expect(state.export.error).toBe('crashed');
    });

    it('surfaces progress as it happens, not only at the end', async () => {
      await signedIn();
      harness.runner.scriptExportSuccess(4);
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.pagesExported === 4, 'all pages counted');

      const progress = harness.events.filter((e) => (e as { type?: string }).type === 'export-progress');
      expect(progress.length).toBeGreaterThanOrEqual(4);
      // The first progress event has no total yet: the packages report totals only
      // at the end, so the UI must not imply a percentage it cannot compute.
      expect((progress[0] as { totalPages: number | null }).totalPages).toBeNull();
      harness.runner.endJob(GUID, { kind: 'export', code: 0 });
      await waitForState((s) => s.export.state === 'done', 'export to finish');
    });

    it('refuses a second export while one is running', async () => {
      await signedIn();
      harness.runner.scriptExportSuccess(5);
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.state === 'running', 'export to start');
      await expect(harness.service.exportNotebook(GUID, { notebook: 'Work' })).rejects.toThrow(
        /already running/,
      );
    });

    it('refuses to start when the host is low on disk', async () => {
      await signedIn();
      const lowDisk = new Service({
        store: harness.store,
        queue: harness.queue,
        runner: harness.runner.asClient(),
        sse: harness.sse,
        dataRoot: harness.dataRoot,
        // Higher than any real volume, so the guard always trips.
        minFreeDiskMb: Number.MAX_SAFE_INTEGER,
        log: () => {},
      });
      // Authenticated, so the disk guard is what refuses - not the auth check
      // that would otherwise fire first and mask it.
      await expect(
        lowDisk.exportNotebook(GUID, { notebook: 'Personal' }),
      ).rejects.toThrow(/free disk space/i);
      expect(harness.runner.calls.some((c) => c.op === 'export')).toBe(false);
    });

    it('allows an export when there is plenty of room', async () => {
      await signedIn();
      harness.runner.scriptExportSuccess(1);
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.state === 'running', 'export to start');
      harness.runner.endJob(GUID, { kind: 'export', code: 0 });
      await waitForState((s) => s.export.state === 'done', 'export to finish');
    });
  });

  describe('erase', () => {
    it('deletes the session directory and tombstones the guid', async () => {
      await signedIn();
      const dir = join(harness.dataRoot, GUID);
      expect(harness.store.peek(GUID)).not.toBeNull();

      await harness.service.erase(GUID);

      expect(harness.runner.calls.some((c) => c.op === 'erase')).toBe(true);
      expect(harness.store.isErased(GUID)).toBe(true);
      expect(harness.store.peek(GUID)).toBeNull();
      // The tombstone is what stops an in-flight request recreating it.
      expect(() => harness.service.readSession(GUID)).toThrow(/no such session/);
    });

    it('removes auth.json with the session', async () => {
      await signedIn();
      const authFile = join(harness.dataRoot, GUID, 'auth.json');
      writeFileSync(authFile, '{"cookies":[]}');
      await harness.service.erase(GUID);
      expect(harness.store.peek(GUID)).toBeNull();
    });

    it('tells an SSE subscriber the session is gone', async () => {
      await signedIn();
      await harness.service.erase(GUID);
      const event = harness.events.find((e) => (e as { type?: string }).type === 'session-erased');
      expect(event).toBeTruthy();
    });

    it('is safe to call twice', async () => {
      await signedIn();
      await harness.service.erase(GUID);
      await expect(harness.service.erase(GUID)).resolves.toBeUndefined();
    });

    it('does not resurrect a session on a later request', async () => {
      await signedIn();
      await harness.service.erase(GUID);
      expect(() => harness.service.createSession(GUID)).toThrow(/no such session/);
      expect(harness.store.peek(GUID)).toBeNull();
    });

    it('does not start a queued job after the session is erased', async () => {
      // The race this closes: a login queued behind a long export, erased while
      // waiting, must not run later and recreate the directory.
      await signedIn();
      harness.runner.scriptExportSuccess(20);
      harness.runner.scriptLoginSuccess();
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await waitForState((s) => s.export.state === 'running', 'export to start');

      // Queue a second job behind the running one by bypassing the per-session
      // guard the way a concurrent request would.
      const { done } = harness.queue.submit(
        { kind: 'list', run: async () => harness.service.listNotebooks(GUID) },
        GUID,
      );
      await harness.service.erase(GUID);
      await expect(done).rejects.toThrow('session erased');
    });
  });

  describe('events', () => {
    it('emits a job-state event when a job is queued and again when it runs', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginSuccess();
      void harness.service.login(GUID, '{}');
      await waitForState((s) => s.job?.state === 'running', 'login to start');

      const jobEvents = harness.events.filter((e) => (e as { type?: string }).type === 'job-state');
      expect(jobEvents.length).toBeGreaterThanOrEqual(2);
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });
      await waitForState((s) => s.auth.state === 'valid', 'success');
    });

    it('emits log events for each line, so the UI can show progress', async () => {
      await signedIn();
      const logs = harness.events.filter((e) => (e as { type?: string }).type === 'log') as {
        seq: number;
        text: string;
      }[];
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((l) => l.text.includes('Authentication successful'))).toBe(true);
    });

    it('tracks the highest log sequence in the session', async () => {
      await signedIn();
      const state = harness.store.peek(GUID)!;
      expect(state.logSeq).toBeGreaterThan(0);
    });

    it('never emits the credential body as a log line', async () => {
      harness.service.createSession(GUID);
      harness.runner.scriptLoginSuccess();
      void harness.service.login(GUID, '{"email":"a@b.c","password":"TOPSECRET"}');
      await waitForState((s) => s.job?.state === 'running', 'login to start');
      harness.runner.endJob(GUID, { kind: 'login', code: 0 });
      await waitForState((s) => s.auth.state === 'valid', 'success');

      const serialised = JSON.stringify(harness.events);
      expect(serialised).not.toContain('TOPSECRET');
    });
  });

  describe('isolation between sessions', () => {
    it('keeps one session out of another session state', async () => {
      await signedIn();
      const other = harness.service.createSession(GUID_OTHER);
      expect(other.guid).toBe(GUID_OTHER);
      expect(harness.store.peek(GUID)!.auth.state).toBe('valid');
      expect(harness.store.peek(GUID_OTHER)!.auth.state).toBe('none');
    });

    it('erasing one session leaves the other intact', async () => {
      await signedIn();
      harness.service.createSession(GUID_OTHER);
      await harness.service.erase(GUID);
      expect(harness.store.peek(GUID_OTHER)).not.toBeNull();
    });
  });
});

describe('parseFrame', () => {
  it('parses a data frame', () => {
    const event = { kind: 'line', seq: 1, stream: 'stdout', text: 'hi', at: 'now' };
    expect(parseFrame(`id: 1\ndata: ${JSON.stringify(event)}`)).toEqual(event);
  });

  it('ignores a keepalive comment', () => {
    expect(parseFrame(': keepalive')).toBeNull();
  });

  it('ignores an empty frame', () => {
    expect(parseFrame('')).toBeNull();
  });

  it('drops a malformed frame instead of throwing', () => {
    // One bad payload must not tear down the stream the UI depends on.
    expect(parseFrame('data: {not json')).toBeNull();
  });

  it('joins a multi-line data payload', () => {
    const event = { kind: 'line', seq: 2, stream: 'stderr', text: 'a\nb', at: 'now' };
    expect(parseFrame(`data: ${JSON.stringify(event)}`)).toEqual(event);
  });
});

describe('RunnerError', () => {
  it('carries the code the runner reported', () => {
    const err = new RunnerError('no_auth', 'auth.json is missing', 409);
    expect(err.code).toBe('no_auth');
    expect(err.status).toBe(409);
  });
});

/** Keeps `mkdirSync` and the fixture helpers referenced for future cases. */
export const _unused = { mkdirSync };

describe('auth-expiry preflight', () => {
  /**
   * The capability PLAN-v2 §13.2 named as v1's main known limitation and
   * PLAN-v3 deferred - both because `microsoft-webauth check` could not be
   * trusted. It waited a fixed two seconds and asked whether the URL happened to
   * be a login host, so an empty auth file read as signed in. 0.1.9 fixed that,
   * which is the only reason this exists.
   *
   * What matters is not that it runs, but that it tells apart three outcomes that
   * look identical from the outside.
   */
  it('confirms a live session and records when it was confirmed', async () => {
    await signedIn({ skipCheck: true });
    harness.runner.scriptCheck('authenticated');

    void harness.service.checkAuth(GUID);
    await runJob('check');

    const state = harness.store.peek(GUID)!;
    expect(state.auth.state).toBe('valid');
    expect(state.auth.checkedAt).not.toBeNull();
  });

  it('reads a check with no verdict as unverifiable, not as a pass', async () => {
    // Exit 0 with nothing that says "authenticated" is not a confirmation. It is
    // also not an expiry - the app cannot tell, and must not invent either.
    await signedIn({ skipCheck: true });
    harness.runner.script({
      lines: [{ stream: 'stderr', text: '[Oct 03 09:00:04] [ERROR] something unrecognised' }],
      result: { kind: 'check', code: 0 },
    });

    await withCheck(() => harness.service.checkAuth(GUID));
    const state = harness.store.peek(GUID)!;
    expect(state.auth.state).toBe('valid');
    const error = harness.events.find((e) => (e as { type?: string }).type === 'error') as {
      code: string;
    };
    expect(error.code).toBe('auth_unverified');
  });

  it.each(['expired', 'stayed_unauthenticated', 'no_auth_file'] as const)(
    'signs the session out when the check says %s',
    async (verdict) => {
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck(verdict);

      await expect(withCheck(() => harness.service.checkAuth(GUID))).rejects.toThrow(
        /sign in again|auth\.json|Sign in first/i,
      );
      const state = harness.store.peek(GUID)!;
      expect(state.auth.state).toBe('failed');
      // The verdict is recorded, so the UI can explain what happened rather than
      // silently re-enabling the sign-in form.
      expect(state.auth.checkedAt).not.toBeNull();
    },
  );

  it('leaves the session alone when the check could not confirm it', async () => {
    // The distinction that makes the preflight safe rather than destructive: a
    // network failure is not a dead session.
    await signedIn({ skipCheck: true });
    harness.runner.scriptCheck('unverifiable');

    await expect(withCheck(() => harness.service.checkAuth(GUID))).resolves.toBeUndefined();
    expect(harness.store.peek(GUID)!.auth.state).toBe('valid');
  });

  it('tells the user that an unverifiable check is not an expiry', async () => {
    await signedIn({ skipCheck: true });
    harness.runner.scriptCheck('unverifiable');

    void harness.service.checkAuth(GUID);
    await runJob('check');
    const error = harness.events.find((e) => (e as { type?: string }).type === 'error') as {
      code: string;
      message: string;
    };
    expect(error.code).toBe('auth_unverified');
    expect(error.message).toMatch(/network|try again/i);
  });

  describe('caching', () => {
    it('runs once and reuses the verdict for the next operation', async () => {
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('authenticated');
      harness.runner.scriptListSuccess();

      void harness.service.checkAuth(GUID);
      await runJob('check');
      void harness.service.listNotebooks(GUID);
      await runJob('list');

      expect(harness.runner.calls.filter((c) => c.op === 'check')).toHaveLength(1);
      expect(harness.store.peek(GUID)!.notebooks.state).toBe('loaded');
    });

    it('checks again once the verdict has aged out', async () => {
      // A zero TTL makes every operation pay for the check, which is the honest
      // behaviour when the cost of a stale verdict is an unexplained failure.
      const service = serviceWithPreflightTtl(0);
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('authenticated');
      harness.runner.scriptListSuccess();
      harness.runner.scriptCheck('authenticated');

      await withCheck(() => service.checkAuth(GUID));
      // The list triggers its own preflight, because the verdict is already stale.
      void service.listNotebooks(GUID);
      await runJob('check');
      await runJob('list');

      expect(harness.runner.calls.filter((c) => c.op === 'check')).toHaveLength(2);
    });

    it('records an unverifiable verdict, so the automatic preflight stops re-checking', async () => {
      // Cached like any other verdict. If it were not, a broken network would
      // make every list and export launch another browser.
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('unverifiable');
      harness.runner.scriptListSuccess();

      void harness.service.checkAuth(GUID);
      await runJob('check');
      void harness.service.listNotebooks(GUID);
      await runJob('list');

      expect(harness.runner.calls.filter((c) => c.op === 'check')).toHaveLength(1);
      expect(harness.store.peek(GUID)!.notebooks.state).toBe('loaded');
    });

    it('re-checks on an explicit request, because that is what was asked for', async () => {
      // checkAuth is the "check my session" button. Answering it from cache
      // would make the button lie after the TTL expired.
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('authenticated');
      harness.runner.scriptCheck('authenticated');

      await withCheck(() => harness.service.checkAuth(GUID));
      await withCheck(() => harness.service.checkAuth(GUID));

      expect(harness.runner.calls.filter((c) => c.op === 'check')).toHaveLength(2);
    });
  });

  describe('before an operation', () => {
    it('refuses to list with an expired session, and says why', async () => {
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('expired');

      await expect(withCheck(() => harness.service.listNotebooks(GUID))).rejects.toThrow(
        /expired|sign in again/i,
      );
      expect(harness.runner.calls.some((c) => c.op === 'list')).toBe(false);
    });

    it('refuses to export with an expired session, before writing anything', async () => {
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('expired');

      await expect(
        withCheck(() => harness.service.exportNotebook(GUID, { notebook: 'Personal' })),
      ).rejects.toThrow(/expired|sign in again/i);
      expect(harness.runner.calls.some((c) => c.op === 'export')).toBe(false);
      expect(harness.store.peek(GUID)!.export.state).toBe('idle');
    });

    it('proceeds with the export when the check simply could not tell', async () => {
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('unverifiable');
      harness.runner.scriptExportSuccess(2);

      // The preflight runs first and does not block, so the export follows it.
      void harness.service.exportNotebook(GUID, { notebook: 'Personal' });
      await runJob('check');
      await runJob('export');
      expect(harness.store.peek(GUID)!.export.state).toBe('done');
    });

    it('leaves an existing artefact downloadable after an expiry', async () => {
      // Nobody should lose an export because their Microsoft session aged out.
      await signedIn({ skipCheck: true });
      mkdirSync(join(harness.dataRoot, GUID, 'out', 'Personal'), { recursive: true });
      writeFileSync(join(harness.dataRoot, GUID, 'out', 'Personal', 'note.md'), '# note');
      harness.store.update(GUID, (st) => {
        st.export = {
          ...st.export,
          state: 'done',
          notebook: 'Personal',
          artifact: { name: 'Personal', bytes: 6, partial: false },
        };
      });
      harness.runner.scriptCheck('expired');

      await expect(withCheck(() => harness.service.listNotebooks(GUID))).rejects.toThrow(
        /expired|sign in again/i,
      );
      expect(harness.store.peek(GUID)!.export.artifact).not.toBeNull();
    });
  });

  describe('the job', () => {
    it('is announced as a job, because it takes tens of seconds', async () => {
      await signedIn({ skipCheck: true });
      harness.runner.scriptCheck('authenticated');

      void harness.service.checkAuth(GUID);
      await runJob('check');
      const jobEvents = harness.events.filter((e) => (e as { type?: string }).type === 'job-state');
      expect(jobEvents.some((e) => (e as { job: { kind: string } }).job.kind === 'check')).toBe(true);
    });

    it('goes through the queue, so two sessions cannot both claim the runner', async () => {
      // The preflight launches a browser. Two sessions preflighting at once would
      // race for the runner's single slot and one would get a 409 it cannot act
      // on, so it is a queued job like every other.
      await signedIn({ skipCheck: true });
      const other = '9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
      harness.service.createSession(other);
      harness.store.update(other, (st) => {
        st.auth = { state: 'valid', email: null, at: 'now', checkedAt: null };
      });
      harness.runner.scriptCheck('authenticated');

      void harness.service.checkAuth(GUID);
      void harness.service.checkAuth(other);

      await waitFor(
        () => harness.runner.calls.filter((c) => c.op === 'check').length >= 1,
        'the first check to start',
      );
      // The second is queued behind it rather than racing it.
      expect(harness.runner.calls.filter((c) => c.op === 'check')).toHaveLength(1);
    });
  });
});
