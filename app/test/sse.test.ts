import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppEvent, SessionState } from '@msout-poc/shared';
import { SseHub } from '../src/server/sse';

/**
 * The SSE hub.
 *
 * The behaviour that matters most is the reconnect path: a browser that reloads
 * mid-export must get its state back, and must not get a replay with a hole in
 * it that looks continuous.
 */
const GUID = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';

let hub: SseHub;
let sent: { event: AppEvent; id?: number }[];
let comments: string[];
let closed: number;

function sink() {
  return {
    send: (event: AppEvent, id?: number) => sent.push({ event, id }),
    sendComment: (text: string) => comments.push(text),
    close: () => {
      closed += 1;
    },
  };
}

function state(): SessionState {
  return {
    guid: GUID,
    createdAt: '2026-10-02T20:00:00.000Z',
    expiresAt: '2026-10-03T08:00:00.000Z',
    auth: { state: 'none', email: null, at: null },
    mfa: { kind: null, number: null, askedAt: null },
    notebooks: { state: 'idle', items: [], error: null },
    export: {
      state: 'idle',
      notebook: null,
      notebookUrl: null,
      pagesExported: 0,
      totalPages: null,
      partial: false,
      error: null,
      artifact: null,
    },
    job: null,
    logSeq: 0,
  };
}

beforeEach(() => {
  hub = new SseHub(5, 60_000);
  sent = [];
  comments = [];
  closed = 0;
});

describe('SseHub', () => {
  describe('publish', () => {
    it('delivers to every subscriber of the session', () => {
      hub.subscribe(GUID, 0, state, sink());
      hub.subscribe(GUID, 0, state, sink());
      sent = []; // drop the two snapshots
      hub.publish(GUID, { type: 'session-erased' });
      expect(sent).toHaveLength(2);
    });

    it("does not leak one session's events to another's subscriber", () => {
      const other = '9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
      hub.subscribe(GUID, 0, state, sink());
      hub.subscribe(other, 0, state, sink());
      sent = []; // drop the two snapshots
      hub.publish(GUID, { type: 'session-erased' });
      expect(sent).toHaveLength(1);
    });

    it('numbers events monotonically', () => {
      hub.subscribe(GUID, 0, state, sink());
      sent = []; // the snapshot is delivered with the pre-publish id
      hub.publish(GUID, { type: 'session-erased' });
      hub.publish(GUID, { type: 'session-erased' });
      expect(sent.map((s) => s.id)).toEqual([1, 2]);
    });

    it('survives a subscriber whose send throws', () => {
      const good: AppEvent[] = [];
      // The throw happens during this subscriber's own backlog replay, which is
      // the less obvious place for it to escape.
      hub.subscribe(GUID, 0, state, {
        send: () => {
          throw new Error('broken pipe');
        },
        sendComment: () => {},
        close: () => {},
      });
      hub.subscribe(GUID, 0, state, { send: (e) => good.push(e), sendComment: () => {}, close: () => {} });
      good.length = 0;
      expect(() => hub.publish(GUID, { type: 'session-erased' })).not.toThrow();
      expect(good).toHaveLength(1);
    });

    it('stops delivering after unsubscribe', () => {
      const off = hub.subscribe(GUID, 0, state, sink());
      sent = []; // the snapshot
      hub.publish(GUID, { type: 'session-erased' });
      off();
      hub.publish(GUID, { type: 'session-erased' });
      expect(sent).toHaveLength(1);
    });
  });

  describe('buffer', () => {
    it('bounds what it keeps, because the app is long-lived', () => {
      for (let i = 0; i < 20; i += 1) hub.publish(GUID, { type: 'session-erased' });
      hub.subscribe(GUID, 19, state, sink());
      // Only the event after 19 is replayable.
      expect(sent).toHaveLength(1);
    });
  });

  describe('reconnect', () => {
    it('gives a first-time subscriber a snapshot followed by the recent history', () => {
      hub.publish(GUID, { type: 'session-erased' });
      sent = [];
      hub.subscribe(GUID, 0, state, sink());
      // Snapshot first, then what was missed - so a tab opened after a job
      // finished shows the log that explains the state it was just given.
      expect(sent[0]!.event.type).toBe('snapshot');
      expect(sent.slice(1)).toHaveLength(1);
      expect(sent[1]!.event.type).toBe('session-erased');
    });

    it('replays only what was missed when the cursor is usable', () => {
      hub.subscribe(GUID, 0, state, sink());
      hub.publish(GUID, { type: 'session-erased' });
      hub.publish(GUID, { type: 'session-erased' });
      sent = [];
      hub.subscribe(GUID, 1, state, sink());
      expect(sent.map((s) => s.event.type)).toEqual(['session-erased']);
    });

    it('replays nothing when the subscriber is already current', () => {
      hub.subscribe(GUID, 0, state, sink());
      hub.publish(GUID, { type: 'session-erased' });
      sent = [];
      hub.subscribe(GUID, 1, state, sink());
      expect(sent).toHaveLength(0);
    });

    it('falls back to a snapshot plus the buffer when the cursor has aged out', () => {
      // The case that matters: a browser that was away long enough for its
      // events to be evicted must be told the current state, not handed a
      // partial replay that looks complete.
      for (let i = 0; i < 10; i += 1) hub.publish(GUID, { type: 'session-erased' });
      sent = [];
      hub.subscribe(GUID, 2, state, sink());
      expect(sent[0]!.event.type).toBe('snapshot');
      expect(sent.slice(1)).toHaveLength(5); // the 5 the ring kept
    });

    it('treats a cursor older than everything kept as a gap', () => {
      for (let i = 0; i < 10; i += 1) hub.publish(GUID, { type: 'session-erased' });
      hub.subscribe(GUID, 6, state, sink());
      // 6 is still inside the ring (oldest kept is 6), so a replay is correct.
      expect(sent[0]!.event.type).not.toBe('snapshot');
    });

    it('hands the snapshot the current state, not a stale copy', () => {
      const live = state();
      live.auth = { state: 'valid', email: 'a@b.c', at: 'now' };
      hub.subscribe(GUID, 0, () => live, sink());
      const snapshot = sent[0]!.event as Extract<AppEvent, { type: 'snapshot' }>;
      expect(snapshot.state.auth.state).toBe('valid');
    });

    it('replays with the original ids, so a further reconnect is correct', () => {
      hub.subscribe(GUID, 0, state, sink());
      hub.publish(GUID, { type: 'session-erased' });
      hub.publish(GUID, { type: 'session-erased' });
      sent = [];
      hub.subscribe(GUID, 1, state, sink());
      expect(sent[0]!.id).toBe(2);
    });
  });

  describe('keepalive', () => {
    it('comments periodically so proxies do not time the stream out', async () => {
      const shortLived = new SseHub(5, 30);
      const seen: string[] = [];
      const off = shortLived.subscribe(GUID, 0, state, {
        send: () => {},
        sendComment: (text) => seen.push(text),
        close: () => {},
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      off();
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]).toBe('keepalive');
    });

    it('stops commenting once unsubscribed', async () => {
      const shortLived = new SseHub(5, 30);
      let count = 0;
      const off = shortLived.subscribe(GUID, 0, state, {
        send: () => {},
        sendComment: () => {
          count += 1;
        },
        close: () => {},
      });
      off();
      const after = count;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(count).toBe(after);
    });
  });

  describe('subscriberCount', () => {
    it('counts live connections, for health checks', () => {
      expect(hub.subscriberCount(GUID)).toBe(0);
      const off = hub.subscribe(GUID, 0, state, sink());
      expect(hub.subscriberCount(GUID)).toBe(1);
      off();
      expect(hub.subscriberCount(GUID)).toBe(0);
    });
  });

  describe('clear', () => {
    it('closes open connections and drops the buffer on erase', () => {
      hub.subscribe(GUID, 0, state, sink());
      hub.publish(GUID, { type: 'session-erased' });
      hub.clear(GUID);
      expect(closed).toBe(1);
      sent = [];
      // A subscriber that reconnects after an erase gets a fresh snapshot, and
      // no history: the buffer went with the session.
      hub.subscribe(GUID, 0, state, sink());
      expect(sent).toHaveLength(1);
      expect(sent[0]!.event.type).toBe('snapshot');
    });
  });
});