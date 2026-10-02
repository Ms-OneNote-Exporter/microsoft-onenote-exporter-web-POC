import type { SessionStore } from './session-store';

/**
 * Expiry sweeper.
 *
 * The POC has one TTL and no idle TTL, which is the opposite of PLAN-v2 §2.1 and
 * for a defensible reason: with global concurrency 1, holding a slot for an idle
 * session would block every other session, which is the DoS PLAN-v2 was written
 * to remove. The trade accepted here is that one busy user can stall the service
 * for the duration of one export - visible in the queue position rather than
 * silent.
 *
 * The 12h budget is absolute and fixed at creation, so an idle session expires on
 * schedule whether or not anyone is looking at it.
 */
export class Sweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly intervalMs: number,
    private readonly onErase: (guid: string) => void,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.intervalMs);
    // Not holding the process open for a cleanup timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs one pass. Exposed so a test can drive it without a timer. */
  sweep(now: Date = new Date()): string[] {
    const erased: string[] = [];
    for (const guid of this.store.listGuids()) {
      const state = this.store.peek(guid);
      // peek can return null if the session vanished mid-pass; nothing to do.
      if (!state) continue;
      if (!this.store.isExpired(state, now)) continue;
      this.store.erase(guid);
      erased.push(guid);
      this.log(`expired session ${guid.slice(0, 8)}…`);
    }
    for (const guid of erased) this.onErase(guid);
    return erased;
  }
}