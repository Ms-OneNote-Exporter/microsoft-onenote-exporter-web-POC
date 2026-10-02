import { describe, expect, it } from 'vitest';
import { JobQueue } from '../src/server/queue';

const GUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GUID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** Waits for a condition, so tests assert on state rather than on tick counts. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for condition');
}

/**
 * Lets the queue advance.
 *
 * `submit` defers `drain` to a microtask so a caller can record the queued job
 * before the job's own state write lands. Tests that inspect the queue right
 * after submitting therefore have to wait for that microtask, rather than
 * assuming the job started synchronously.
 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A job that resolves when its gate opens. */
function gated(label: string, log: string[]) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    label,
    open,
    request: {
      kind: 'login' as const,
      run: async () => {
        log.push(`start:${label}`);
        await gate;
        log.push(`end:${label}`);
        return label;
      },
    },
  };
}

describe('JobQueue', () => {
  it('starts the first job immediately', async () => {
    const queue = new JobQueue();
    const log: string[] = [];
    const job = gated('first', log);
    const { done } = queue.submit(job.request, GUID_A);
    await settle();
    expect(log).toEqual(['start:first']);
    job.open();
    await expect(done).resolves.toBe('first');
  });

  it('runs jobs one at a time, in submission order', async () => {
    const queue = new JobQueue();
    const log: string[] = [];
    const first = gated('1', log);
    const second = gated('2', log);
    const third = gated('3', log);

    const d1 = queue.submit(first.request, GUID_A).done;
    const d2 = queue.submit(second.request, GUID_B).done;
    const d3 = queue.submit(third.request, GUID_A).done;

    await settle();
    // Only the first is running; the other two are waiting their turn.
    expect(log).toEqual(['start:1']);
    expect(queue.busy).toBe(true);

    first.open();
    await d1;
    await settle();
    expect(log).toEqual(['start:1', 'end:1', 'start:2']);

    second.open();
    await d2;
    await settle();
    expect(log).toContain('start:3');

    third.open();
    await d3;
    expect(log).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  });

  it('does not run a queued job until the one before it has finished', async () => {
    // The property that makes concurrency 1 real: overlapping browsers must never
    // start two children at once.
    const queue = new JobQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    const make = (n: number) => ({
      kind: 'list' as const,
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent -= 1;
        return n;
      },
    });

    const results = await Promise.all([
      queue.submit(make(1), GUID_A).done,
      queue.submit(make(2), GUID_A).done,
      queue.submit(make(3), GUID_A).done,
    ]);
    expect(maxConcurrent).toBe(1);
    expect(results).toEqual([1, 2, 3]);
  });

  it('reports a queued job position, and null once it is running', async () => {
    const queue = new JobQueue();
    const log: string[] = [];
    const first = gated('first', log);
    const second = gated('second', log);

    const a = queue.submit(first.request, GUID_A);
    const b = queue.submit(second.request, GUID_B);
    await settle();

    expect(queue.positionOf(a.id)).toBeNull(); // already running
    expect(queue.positionOf(b.id)).toBe(1);

    first.open();
    await a.done;
    await settle();
    expect(queue.positionOf(b.id)).toBeNull(); // now running

    second.open();
    await b.done;
  });

  it('numbers positions across sessions, so a queued login shows the export ahead of it', async () => {
    // The case the plan cares about: a session blocked behind another session's
    // long export is told so, rather than seeing a spinner that never resolves.
    const queue = new JobQueue();
    const log: string[] = [];
    const exportJob = gated('export', log);
    const loginJob = gated('login', log);
    const listJob = gated('list', log);

    queue.submit(exportJob.request, GUID_A);
    const second = queue.submit(loginJob.request, GUID_B);
    const third = queue.submit(listJob.request, GUID_C);
    await settle();

    // Three jobs, concurrency 1: the first runs and the other two queue behind it.
    expect(queue.snapshot().running?.guid).toBe(GUID_A);
    expect(queue.positionOf(second.id)).toBe(1);
    expect(queue.positionOf(third.id)).toBe(2);

    // Advancing the queue takes several microtasks (the previous job's `run`
    // settles, then `finally` clears `running`, then `drain` shifts the next),
    // so wait for the observable condition instead of guessing a tick count.
    exportJob.open();
    await waitFor(() => queue.snapshot().running?.guid === GUID_B);
    expect(queue.positionOf(third.id)).toBe(1);
    expect(queue.positionOf(second.id)).toBeNull();

    loginJob.open();
    listJob.open();
  });

  describe('snapshot', () => {
    it('names what is running and what is waiting', async () => {
      const queue = new JobQueue();
      const log: string[] = [];
      const first = gated('first', log);
      const second = gated('second', log);
      queue.submit(first.request, GUID_A);
      const b = queue.submit(second.request, GUID_B);
      await settle();

      const snap = queue.snapshot();
      expect(snap.running).toMatchObject({ kind: 'login', guid: GUID_A });
      expect(snap.pending).toHaveLength(1);
      expect(snap.pending[0]).toMatchObject({ guid: GUID_B, position: 1 });

      first.open();
      second.open();
      expect(b.id).toBeTruthy();
    });

    it('is empty when nothing is queued', () => {
      const queue = new JobQueue();
      expect(queue.snapshot()).toEqual({ running: null, pending: [] });
      expect(queue.busy).toBe(false);
    });
  });

  describe('failure', () => {
    it('rejects the failing job and keeps draining the queue', async () => {
      const queue = new JobQueue();
      const log: string[] = [];
      const failing = {
        kind: 'login' as const,
        run: async () => {
          throw new Error('runner exploded');
        },
      };
      const after = gated('after', log);

      const d1 = queue.submit(failing, GUID_A).done;
      const d2 = queue.submit(after.request, GUID_B).done;

      await expect(d1).rejects.toThrow('runner exploded');
      await settle();
      // A job that throws must not wedge the queue for everyone else.
      expect(log).toEqual(['start:after']);
      after.open();
      await d2;
    });

    it('is idle again after a failure', async () => {
      const queue = new JobQueue();
      const d = queue.submit(
        {
          kind: 'login',
          run: async () => {
            throw new Error('nope');
          },
        },
        GUID_A,
      ).done;
      await expect(d).rejects.toThrow();
      expect(queue.busy).toBe(false);
      expect(queue.snapshot()).toEqual({ running: null, pending: [] });
    });
  });

  describe('per-session conflicts', () => {
    it('reports work already in flight for a session', async () => {
      const queue = new JobQueue();
      const log: string[] = [];
      const running = gated('running', log);
      queue.submit(running.request, GUID_A);
      const queued = gated('queued', log);
      queue.submit(queued.request, GUID_A);

      expect(queue.hasWorkFor(GUID_A)).toBe(true);
      expect(queue.hasWorkFor(GUID_B)).toBe(false);
      running.open();
      queued.open();
    });

    it('reports the running guid', async () => {
      const queue = new JobQueue();
      const log: string[] = [];
      const job = gated('j', log);
      queue.submit(job.request, GUID_B);
      await settle();
      expect(queue.runningGuid()).toBe(GUID_B);
      job.open();
    });
  });

  describe('cancelQueuedFor', () => {
    it('rejects queued jobs for an erased session instead of running them later', async () => {
      // A queued login for a session the user just erased must not start after
      // the fact: it would recreate the session directory.
      const queue = new JobQueue();
      const log: string[] = [];
      const running = gated('running', log);
      const doomed = gated('doomed', log);
      const other = gated('other', log);

      const dr = queue.submit(running.request, GUID_A).done;
      const d1 = queue.submit(doomed.request, GUID_A).done;
      const d2 = queue.submit(other.request, GUID_B).done;
      // Let the first job claim the running slot, so the two later ones are
      // genuinely queued when cancelQueuedFor looks at them.
      await settle();

      const removed = queue.cancelQueuedFor(GUID_A);
      expect(removed).toHaveLength(1);
      await expect(d1).rejects.toThrow('session erased');

      running.open();
      await dr;
      other.open();
      await d2;
      expect(log).not.toContain('start:doomed');
    });

    it('leaves other sessions queued', async () => {
      const queue = new JobQueue();
      const log: string[] = [];
      const a = gated('a', log);
      const b = gated('b', log);
      // A's promise is rejected by the cancel and deliberately not awaited: the
      // test is about B surviving, and an unhandled rejection would fail the run.
      const da = queue.submit(a.request, GUID_A).done;
      void da.catch(() => {});
      const db = queue.submit(b.request, GUID_B).done;
      await settle();
      queue.cancelQueuedFor(GUID_A);
      expect(queue.hasWorkFor(GUID_B)).toBe(true);
      a.open();
      b.open();
      await db;
    });

    it('does not touch a job that is already running', async () => {
      // Aborting a running job is the runner's job, via SIGTERM - not the
      // queue's, which has no handle on the child process.
      const queue = new JobQueue();
      const log: string[] = [];
      const running = gated('running', log);
      const d = queue.submit(running.request, GUID_A).done;
      await settle();
      expect(queue.cancelQueuedFor(GUID_A)).toEqual([]);
      running.open();
      await d;
    });
  });

  describe('change notifications', () => {
    it('notifies on submit, on start and on completion', async () => {
      const queue = new JobQueue();
      const log: string[] = [];
      const job = gated('j', log);
      const seen: string[] = [];
      queue.onChange((snap) => {
        seen.push(snap.running ? `running:${snap.running.id}` : snap.pending.length ? 'pending' : 'idle');
      });
      const { id, done } = queue.submit(job.request, GUID_A);
      await settle();
      job.open();
      await done;
      expect(seen[0]).toBe('pending');
      expect(seen).toContain(`running:${id}`);
      expect(seen.at(-1)).toBe('idle');
    });

    it('survives a listener that throws', async () => {
      const queue = new JobQueue();
      queue.onChange(() => {
        throw new Error('bad listener');
      });
      const log: string[] = [];
      const job = gated('j', log);
      const { done } = queue.submit(job.request, GUID_A);
      job.open();
      await expect(done).resolves.toBe('j');
    });

    it('stops notifying after unsubscribe', async () => {
      const queue = new JobQueue();
      let count = 0;
      const off = queue.onChange(() => {
        count += 1;
      });
      const log: string[] = [];
      const a = gated('a', log);
      const { done } = queue.submit(a.request, GUID_A);
      const afterFirst = count;
      off();
      a.open();
      await done;
      expect(count).toBe(afterFirst);
    });
  });
});