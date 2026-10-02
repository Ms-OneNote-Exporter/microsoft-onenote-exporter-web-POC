import type { JobKind } from '@msout-poc/shared';

/**
 * A FIFO job queue with global concurrency 1.
 *
 * The POC runs one job at a time across all sessions, which is the plan's stated
 * trade: a single runner container, one browser's worth of memory, and no pool
 * to manage. The cost is that one 30-minute export blocks every other session -
 * so position in the queue is surfaced to the user rather than hidden.
 *
 * A queue rather than a mutex, because the requests that arrive during a long
 * export are login and list calls from *other* sessions, and dropping them would
 * be worse than making them wait.
 */

export interface JobRequest<T> {
  kind: JobKind;
  /** Runs the job. Rejecting marks the job failed rather than retrying it. */
  run: () => Promise<T>;
}

interface QueueEntry<T> {
  id: string;
  kind: JobKind;
  guid: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
}

/** Number of jobs ahead of a given job id, 1-based. Null once it has started. */
export type Positions = Map<string, number>;

export class JobQueue {
  private readonly pending: QueueEntry<unknown>[] = [];
  private running: QueueEntry<unknown> | null = null;
  private counter = 0;

  /** Notified whenever the queue changes shape, so the UI can refresh positions. */
  private readonly listeners = new Set<(info: QueueSnapshot) => void>();

  get busy(): boolean {
    return this.running !== null;
  }

  /** What is running and what is waiting. Safe to hand to a client. */
  snapshot(): QueueSnapshot {
    return {
      running: this.running
        ? { id: this.running.id, kind: this.running.kind, guid: this.running.guid, since: this.running.enqueuedAt }
        : null,
      pending: this.pending.map((entry, index) => ({
        id: entry.id,
        kind: entry.kind,
        guid: entry.guid,
        position: index + 1,
      })),
    };
  }

  onChange(fn: (info: QueueSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // A listener that throws must not stop the queue from draining.
      }
    }
  }

  /** 1-based position of a queued job, or null if it is unknown or already started. */
  positionOf(id: string): number | null {
    const index = this.pending.findIndex((entry) => entry.id === id);
    return index === -1 ? null : index + 1;
  }

  /** The guid currently being served, for per-session conflict checks. */
  runningGuid(): string | null {
    return this.running?.guid ?? null;
  }

  /**
   * Id of the job for a session, queued or running, or null when there is none.
   *
   * Lets a job report itself under the id the caller was already given, instead
   * of inventing one: the caller shows that id in the UI, and a mismatch would
   * mean a job whose displayed identity changes the moment it starts.
   *
   * The running slot is checked too, because by the time a job's body asks for
   * its own id, `drain` has already shifted it out of `pending`.
   */
  jobIdFor(guid: string): string | null {
    if (this.running?.guid === guid) return this.running.id;
    return this.pending.find((entry) => entry.guid === guid)?.id ?? null;
  }

  /** True when this session already has work in flight, queued or running. */
  hasWorkFor(guid: string): boolean {
    return this.running?.guid === guid || this.pending.some((entry) => entry.guid === guid);
  }

  /**
   * Enqueues a job and resolves with its result.
   *
   * `run` is invoked only when the job reaches the front, so a caller awaiting
   * this promise is waiting for the queue, not holding a slot.
   */
  submit<T>(request: JobRequest<T>, guid: string): { id: string; done: Promise<T> } {
    const id = `job-${++this.counter}`;
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.pending.push({
      id,
      kind: request.kind,
      guid,
      run: request.run as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
      enqueuedAt: Date.now(),
    } as QueueEntry<unknown>);

    this.notify();
    // Deferred, not synchronous: the caller still has state bookkeeping to do
    // after submit returns (recording the queued position, emitting job-state),
    // and a job that started inline would write `running` before the caller got
    // to write `queued`, leaving the session stuck showing "queued" for a job
    // that is already running.
    queueMicrotask(() => void this.drain());
    return { id, done };
  }

  private async drain(): Promise<void> {
    // Guarded against re-entry: `drain` is called from `submit` and from the
    // completion of the previous job, and both can land in the same tick.
    if (this.running) return;
    const next = this.pending.shift();
    if (!next) {
      this.notify();
      return;
    }
    this.running = next;
    this.notify();

    try {
      const value = await next.run();
      next.resolve(value);
    } catch (error) {
      next.reject(error);
    } finally {
      if (this.running === next) this.running = null;
      this.notify();
      void this.drain();
    }
  }

  /**
   * Removes queued jobs for a session, rejecting their promises.
   *
   * Used by erase: a queued login for a session that no longer exists must not
   * start later and recreate the directory. A job that is already *running* is
   * not touched here - aborting it is the runner's job.
   */
  cancelQueuedFor(guid: string): string[] {
    const removed: string[] = [];
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const entry = this.pending[i]!;
      if (entry.guid !== guid) continue;
      this.pending.splice(i, 1);
      removed.push(entry.id);
      entry.reject(new Error('session erased'));
    }
    if (removed.length > 0) this.notify();
    return removed;
  }
}

export interface QueueSnapshot {
  running: { id: string; kind: JobKind; guid: string; since: number } | null;
  pending: { id: string; kind: JobKind; guid: string; position: number }[];
}