import type { AppEvent, SessionState } from '@msout-poc/shared';

/**
 * Per-session SSE fan-out with replay.
 *
 * One stream per session, shared by every tab. A refresh mid-export must restore
 * state rather than restart anything, which is why the buffer and the snapshot
 * event exist: the browser reconnects with the last sequence it saw, and gets
 * either the events it missed or a fresh snapshot.
 */

const KEEPALIVE_MS = 15_000;

interface Subscriber {
  /** Writes a raw SSE frame. */
  send: (event: AppEvent, id?: number) => void;
  sendComment: (text: string) => void;
  close: () => void;
}

interface SessionStream {
  /** Recent events, oldest first. */
  buffer: { id: number; event: AppEvent }[];
  nextId: number;
  subscribers: Set<Subscriber>;
}

export class SseHub {
  private readonly streams = new Map<string, SessionStream>();

  constructor(
    private readonly bufferSize = 500,
    private readonly keepaliveMs = KEEPALIVE_MS,
  ) {}

  private stream(guid: string): SessionStream {
    let s = this.streams.get(guid);
    if (!s) {
      s = { buffer: [], nextId: 1, subscribers: new Set() };
      this.streams.set(guid, s);
    }
    return s;
  }

  /** Publishes an event to every subscriber of a session. */
  publish(guid: string, event: AppEvent): void {
    const s = this.stream(guid);
    const id = s.nextId++;
    s.buffer.push({ id, event });
    if (s.buffer.length > this.bufferSize) {
      s.buffer.splice(0, s.buffer.length - this.bufferSize);
    }
    for (const sub of s.subscribers) {
      try {
        sub.send(event, id);
      } catch {
        // A dead connection must not stop the session's other tabs updating.
      }
    }
  }

  /**
   * Registers a subscriber and replays what it missed.
   *
   * `state` is sent as a `snapshot` whenever the caller's cursor is unusable -
   * first connection, or a cursor that has aged out of the buffer. A replay with
   * a hole in it looks continuous, which is worse than an honest snapshot.
   */
  subscribe(
    guid: string,
    lastEventId: number,
    state: () => SessionState,
    subscriber: Subscriber,
  ): () => void {
    const s = this.stream(guid);
    s.subscribers.add(subscriber);

    const oldest = s.buffer[0]?.id ?? s.nextId;
    const cursorUsable = lastEventId > 0 && lastEventId >= oldest - 1;

    // Every send is guarded, the backlog replay included. A subscriber that
    // throws while catching up would otherwise abort the whole subscribe call -
    // and with it the HTTP handler that was setting the stream up.
    const guardedSend = (event: AppEvent, id?: number): void => {
      try {
        subscriber.send(event, id);
      } catch {
        /* the connection is gone; the stream continues for everyone else */
      }
    };

    if (cursorUsable) {
      for (const entry of s.buffer) {
        if (entry.id > lastEventId) guardedSend(entry.event, entry.id);
      }
    } else {
      // Snapshot *and* the whole buffer. State alone is not enough for a tab
      // opened after a job has finished: it would show "sign-in failed" next to
      // an empty log, which reads as a bug rather than as history the server
      // simply had not been asked for yet. The buffer is bounded, so this stays
      // a few hundred lines at worst.
      guardedSend({ type: 'snapshot', state: state() }, s.nextId - 1);
      for (const entry of s.buffer) guardedSend(entry.event, entry.id);
    }

    const keepalive = setInterval(() => {
      try {
        subscriber.sendComment('keepalive');
      } catch {
        /* closed */
      }
    }, this.keepaliveMs);

    return () => {
      clearInterval(keepalive);
      s.subscribers.delete(subscriber);
      // The stream object is kept: its buffer is the replay history, and a tab
      // that reconnects after a network blip needs it.
    };
  }

  /** Number of connected subscribers, for /healthz and tests. */
  subscriberCount(guid: string): number {
    return this.streams.get(guid)?.subscribers.size ?? 0;
  }

  /** Forgets a session's buffer and subscribers. Called by erase. */
  clear(guid: string): void {
    const s = this.streams.get(guid);
    if (!s) return;
    for (const sub of s.subscribers) {
      try {
        sub.close();
      } catch {
        /* already gone */
      }
    }
    this.streams.delete(guid);
  }
}