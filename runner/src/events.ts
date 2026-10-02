/**
 * Per-session event ring buffer and fan-out.
 *
 * This is the runner's only notion of "what happened". There is no event bus, no
 * job state machine and no progress counter on this side: interpreting output
 * lines is the app's job (`app/src/server/log-parser.ts`), so every judgement
 * about what a line *means* lives in one process instead of being split across
 * two.
 *
 * Two kinds of event share one sequence space:
 *   - `line`: a stripped line of child stdout/stderr, exactly as emitted.
 *   - `end`: the terminal outcome (exit code, signal, aborted, timed out).
 *
 * `end` is an event rather than a field on the line stream because the exit code
 * is the one thing the app cannot reconstruct from the logs - and because
 * `microsoft-webauth login` exits 0 on failure, so the app must know how the
 * process ended even when the log looks conclusive.
 */

/** How a child process ended. */
export interface JobResult {
  kind: 'login' | 'list' | 'export';
  /** Exit code, or null when the process died from a signal. */
  code: number | null;
  signal: string | null;
  durationMs: number;
  /** Killed because it exceeded its per-kind timeout. */
  timedOut: boolean;
  /** Killed on the user's request. */
  aborted: boolean;
  /**
   * Set when the process never started at all (missing binary, bad path). The
   * app maps it to `crashed`; it is distinct from `code: 0`, which is what
   * `microsoft-webauth login` reports on a failed login.
   */
  spawnError?: string;
}

export type RunnerEvent =
  | {
      kind: 'line';
      seq: number;
      stream: 'stdout' | 'stderr';
      /** ANSI-stripped, trailing newline removed. */
      text: string;
      at: string;
    }
  | { kind: 'end'; seq: number; at: string; result: JobResult };

export type EventSubscriber = (event: RunnerEvent) => void;

interface SessionStream {
  events: RunnerEvent[];
  nextSeq: number;
  subscribers: Set<EventSubscriber>;
}

export class EventHub {
  private readonly sessions = new Map<string, SessionStream>();

  constructor(private readonly ringSize: number) {}

  private stream(guid: string): SessionStream {
    let s = this.sessions.get(guid);
    if (!s) {
      s = { events: [], nextSeq: 1, subscribers: new Set() };
      this.sessions.set(guid, s);
    }
    return s;
  }

  private push(guid: string, make: (seq: number) => RunnerEvent): RunnerEvent {
    const s = this.stream(guid);
    const event = make(s.nextSeq++);
    s.events.push(event);
    // Bounded: a 90-minute export emits thousands of lines and this process is
    // long-lived, so an unbounded buffer is a slow leak.
    if (s.events.length > this.ringSize) {
      s.events.splice(0, s.events.length - this.ringSize);
    }
    for (const sub of s.subscribers) {
      try {
        sub(event);
      } catch {
        // A broken SSE connection must never stop a child from being read.
      }
    }
    return event;
  }

  publishLine(guid: string, stream: 'stdout' | 'stderr', text: string): RunnerEvent {
    const at = new Date().toISOString();
    return this.push(guid, (seq) => ({ kind: 'line', seq, stream, text, at }));
  }

  publishEnd(guid: string, result: JobResult): RunnerEvent {
    const at = new Date().toISOString();
    return this.push(guid, (seq) => ({ kind: 'end', seq, at, result }));
  }

  subscribe(guid: string, fn: EventSubscriber): () => void {
    const s = this.stream(guid);
    s.subscribers.add(fn);
    return () => {
      s.subscribers.delete(fn);
    };
  }

  /**
   * Events after `sinceSeq`, plus whether the caller missed some that have
   * already aged out. `gap` is the signal to send a fresh snapshot instead of a
   * replay with a hole in it that looks continuous.
   */
  history(guid: string, sinceSeq: number): { events: RunnerEvent[]; gap: boolean } {
    const s = this.sessions.get(guid);
    if (!s) return { events: [], gap: false };
    const events = s.events.filter((e) => e.seq > sinceSeq);
    const oldest = s.events[0]?.seq ?? s.nextSeq;
    return { events, gap: sinceSeq > 0 && sinceSeq < oldest - 1 };
  }

  /** Highest sequence emitted for a session, 0 if none. */
  lastSeq(guid: string): number {
    return (this.sessions.get(guid)?.nextSeq ?? 1) - 1;
  }

  /** Drops a session's events and subscribers. Called by erase. */
  clear(guid: string): void {
    this.sessions.delete(guid);
  }
}