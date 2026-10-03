import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { sessionPaths } from '@msout-poc/shared';
import type { RunnerConfig } from './config';
import { type EventHub, type JobResult } from './events';
import { LineReader } from './line-reader';

/** Raised when a second job is requested while one is already running. */
export class JobBusyError extends Error {
  constructor(
    readonly activeGuid: string,
    readonly activeKind: 'login' | 'check' | 'list' | 'export',
  ) {
    super(`a ${activeKind} job is already running for another session`);
    this.name = 'JobBusyError';
  }
}

/** A spawn failure, as distinct from a process that ran and failed. */
export class SpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnError';
  }
}

export interface JobRequest {
  guid: string;
  kind: 'login' | 'check' | 'list' | 'export';
  /** Executable. Always `process.execPath` in practice - see index.ts. */
  command: string;
  args: string[];
  /** Absolute working directory for the child. */
  cwd: string;
  timeoutMs: number;
}

interface ActiveJob {
  guid: string;
  kind: 'login' | 'check' | 'list' | 'export';
  child: ChildProcess;
  startedAt: number;
  timeoutTimer: NodeJS.Timeout;
  killTimer: NodeJS.Timeout | null;
  aborted: boolean;
  timedOut: boolean;
  settled: boolean;
}

/**
 * How long to wait for an unterminated line to stop growing before treating it
 * as a prompt the child is blocked on.
 *
 * `microsoft-webauth` writes `Enter the verification code: ` with no trailing
 * newline and then blocks on stdin. Waiting a beat and publishing the tail is
 * what makes the MFA prompt reach the browser at all.
 */
const TAIL_DEBOUNCE_MS = 120;

export class JobManager {
  private active: ActiveJob | null = null;

  constructor(
    private readonly hub: EventHub,
    private readonly config: RunnerConfig,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  /** GUID and kind of the running job, for a 409 body that says what is blocking. */
  describeActive(): { guid: string; kind: string; since: string } | null {
    if (!this.active) return null;
    return {
      guid: this.active.guid,
      kind: this.active.kind,
      since: new Date(this.active.startedAt).toISOString(),
    };
  }

  /**
   * Starts a job, or throws.
   *
   * Concurrency is 1 for the whole sidecar. The app's queue already serialises,
   * so this is the backstop: two app instances pointed at one runner, or a
   * retry that raced, must not end up with two browsers fighting over two
   * sessions' worth of memory.
   */
  start(request: JobRequest): void {
    if (this.active) throw new JobBusyError(this.active.guid, this.active.kind);

    const paths = sessionPaths(this.config.dataRoot, request.guid);
    for (const dir of [paths.dir, paths.logsDir, paths.outDir, paths.tmpDir, paths.homeDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      // detached, so abort can signal the whole process group: Chromium forks
      // helpers and killing only the node parent orphans them.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The packages resolve their log directory from this one variable, and
        // all three honour it - which is what keeps every app.log and every
        // HTML dump inside the session directory, so erase is one rm -rf.
        ONENOTE_EXPORT_LOG_DIR: paths.logsDir,
        // Anything that writes to $HOME writes inside the session, or the
        // session is not actually erasable with one directory removal.
        HOME: paths.homeDir,
        // A pipe is not a TTY so chalk disables itself already; these make it
        // explicit, for the case where a nested logger ignores that.
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    });

    const job: ActiveJob = {
      guid: request.guid,
      kind: request.kind,
      child,
      startedAt: Date.now(),
      timeoutTimer: setTimeout(() => this.onTimeout(job!), request.timeoutMs),
      killTimer: null,
      aborted: false,
      timedOut: false,
      settled: false,
    };
    this.active = job;

    this.attach(job, 'stdout');
    this.attach(job, 'stderr');

    child.on('error', (err) => {
      this.hub.publishLine(
        request.guid,
        'stderr',
        `runner: failed to start ${request.kind}: ${(err as NodeJS.ErrnoException).message}`,
      );
      this.settle(job, {
        kind: request.kind,
        code: null,
        signal: null,
        durationMs: Date.now() - job.startedAt,
        timedOut: false,
        aborted: false,
        spawnError: err.message,
      });
    });

    child.on('exit', (code, signal) => {
      this.settle(job, {
        kind: request.kind,
        code,
        signal: signal ?? null,
        durationMs: Date.now() - job.startedAt,
        timedOut: job.timedOut,
        aborted: job.aborted,
      });
    });
  }

  /** Wires one output stream: complete lines immediately, the tail after a beat. */
  private attach(job: ActiveJob, stream: 'stdout' | 'stderr'): void {
    const source = job.child[stream];
    if (!source) return;
    const reader = new LineReader();
    let debounce: NodeJS.Timeout | null = null;

    source.on('data', (chunk: Buffer | string) => {
      for (const line of reader.push(chunk.toString())) {
        this.hub.publishLine(job.guid, stream, line);
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        const tail = reader.takeUnpublishedTail();
        if (tail) this.hub.publishLine(job.guid, stream, tail);
      }, TAIL_DEBOUNCE_MS);
    });

    source.on('end', () => {
      if (debounce) clearTimeout(debounce);
      for (const line of reader.push('\n')) this.hub.publishLine(job.guid, stream, line);
      const tail = reader.takeUnpublishedTail();
      if (tail) this.hub.publishLine(job.guid, stream, tail);
    });
  }

  private onTimeout(job: ActiveJob): void {
    if (job.settled) return;
    job.timedOut = true;
    this.hub.publishLine(
      job.guid,
      'stderr',
      `runner: ${job.kind} exceeded its timeout and was stopped`,
    );
    this.kill(job);
  }

  /**
   * Answers a child's stdin prompt - the MFA code path - and then closes stdin.
   *
   * Closing it is not tidiness, it is required for the login to ever finish.
   * `microsoft-webauth` prompts with `readline.createInterface({ input:
   * process.stdin })` and answers with `rl.close()`, but closing a readline
   * interface does not end the underlying stream. The pipe stays open, Node
   * keeps a handle referenced on it, and the login process sits there with its
   * work finished, waiting to be killed by the job timeout. Verified with a
   * minimal repro against the pattern, and reproduced end to end through the
   * sidecar.
   *
   * It is also the correct semantic: a login asks for a code exactly once. After
   * the answer, any further prompt would be answered with EOF, which is a
   * visible failure rather than a silent hang.
   *
   * The value is sanitised rather than trusted: anything that is not a short
   * printable string is refused. The session that can send this already owns the
   * session, but the child is a shell-adjacent surface and the constraint costs
   * nothing.
   */
  sendStdin(guid: string, data: string): boolean {
    const job = this.active;
    if (!job || job.guid !== guid || job.settled) return false;
    const stdin = job.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    if (data.length > 64 || /[^\w\s-]/.test(data)) return false;
    stdin.write(`${data}\n`);
    stdin.end();
    return true;
  }

  /** True when a login for this session is running and could take input. */
  acceptsStdin(guid: string): boolean {
    const job = this.active;
    return Boolean(job && job.guid === guid && job.kind === 'login' && !job.settled);
  }

  /**
   * Aborts a session's job: SIGTERM to the process group, then SIGKILL after the
   * grace period.
   *
   * There is no cooperative cancel - that would need a `signal` option in the
   * export package, which this POC is not allowed to add. So a page caught
   * mid-write can be truncated, which is why partial artifacts are labelled
   * partial. See PLAN-v3(POC).md §7.
   */
  abort(guid: string): boolean {
    const job = this.active;
    if (!job || job.guid !== guid || job.settled) return false;
    job.aborted = true;
    this.hub.publishLine(guid, 'stderr', 'runner: interrupt requested by the user');
    this.kill(job);
    return true;
  }

  private kill(job: ActiveJob): void {
    const pid = job.child.pid;
    if (pid === undefined) return;
    try {
      // Negative pid: the whole group, so no orphaned Chromium helper survives.
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        job.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    if (job.killTimer) return;
    job.killTimer = setTimeout(() => {
      if (job.settled) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          job.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, this.config.abortGraceMs);
  }

  private settle(job: ActiveJob, result: JobResult): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timeoutTimer);
    if (job.killTimer) clearTimeout(job.killTimer);
    try {
      job.child.stdin?.end();
    } catch {
      /* already closed by sendStdin, or the child never had one */
    }
    if (this.active === job) this.active = null;
    this.hub.publishEnd(job.guid, result);
  }
}