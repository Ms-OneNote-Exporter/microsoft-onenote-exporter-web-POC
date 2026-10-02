import { beforeEach, describe, expect, it } from 'vitest';
import { EventHub, type RunnerEvent } from '../src/events';

const GUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('EventHub', () => {
  let hub: EventHub;

  beforeEach(() => {
    hub = new EventHub(5);
  });

  it('assigns a monotonic sequence starting at 1', () => {
    expect(hub.publishLine(GUID_A, 'stdout', 'one').seq).toBe(1);
    expect(hub.publishLine(GUID_A, 'stdout', 'two').seq).toBe(2);
    expect(hub.lastSeq(GUID_A)).toBe(2);
  });

  it('keeps sequences per session, so one GUID cannot renumber another', () => {
    hub.publishLine(GUID_A, 'stdout', 'a1');
    hub.publishLine(GUID_B, 'stdout', 'b1');
    expect(hub.publishLine(GUID_A, 'stdout', 'a2').seq).toBe(2);
    expect(hub.publishLine(GUID_B, 'stdout', 'b2').seq).toBe(2);
  });

  it('shares one sequence space between lines and the end event', () => {
    hub.publishLine(GUID_A, 'stdout', 'line');
    const end = hub.publishEnd(GUID_A, {
      kind: 'login',
      code: 0,
      signal: null,
      durationMs: 5,
      timedOut: false,
      aborted: false,
    });
    expect(end.kind).toBe('end');
    expect(end.seq).toBe(2);
  });

  it('fans out to subscribers', () => {
    const seen: RunnerEvent[] = [];
    hub.subscribe(GUID_A, (e) => seen.push(e));
    hub.publishLine(GUID_A, 'stdout', 'one');
    hub.publishLine(GUID_A, 'stderr', 'two');
    expect(seen.map((e) => e.kind === 'line' ? e.text : 'end')).toEqual(['one', 'two']);
  });

  it('does not deliver one session events to another session subscriber', () => {
    const seenA: RunnerEvent[] = [];
    const seenB: RunnerEvent[] = [];
    hub.subscribe(GUID_A, (e) => seenA.push(e));
    hub.subscribe(GUID_B, (e) => seenB.push(e));
    hub.publishLine(GUID_A, 'stdout', 'for A');
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: RunnerEvent[] = [];
    const off = hub.subscribe(GUID_A, (e) => seen.push(e));
    hub.publishLine(GUID_A, 'stdout', 'before');
    off();
    hub.publishLine(GUID_A, 'stdout', 'after');
    expect(seen).toHaveLength(1);
  });

  it('survives a subscriber that throws, and keeps publishing', () => {
    const good: RunnerEvent[] = [];
    hub.subscribe(GUID_A, () => {
      throw new Error('broken SSE pipe');
    });
    hub.subscribe(GUID_A, (e) => good.push(e));
    expect(() => hub.publishLine(GUID_A, 'stdout', 'still delivered')).not.toThrow();
    expect(good).toHaveLength(1);
  });

  describe('history', () => {
    it('replays everything after the given sequence', () => {
      hub.publishLine(GUID_A, 'stdout', 'a');
      hub.publishLine(GUID_A, 'stdout', 'b');
      hub.publishLine(GUID_A, 'stdout', 'c');
      const { events, gap } = hub.history(GUID_A, 1);
      expect(events.map((e) => (e.kind === 'line' ? e.text : 'end'))).toEqual(['b', 'c']);
      expect(gap).toBe(false);
    });

    it('reports a gap when the requested sequence has aged out', () => {
      for (let i = 0; i < 10; i += 1) hub.publishLine(GUID_A, 'stdout', `line ${i}`);
      // Ring size is 5, so seq 1 is gone but the caller asked to resume from it.
      const { events, gap } = hub.history(GUID_A, 1);
      expect(gap).toBe(true);
      expect(events.length).toBeGreaterThan(0);
    });

    it('does not report a gap for a fresh subscriber at 0', () => {
      hub.publishLine(GUID_A, 'stdout', 'a');
      expect(hub.history(GUID_A, 0).gap).toBe(false);
    });

    it('does not report a gap when the cursor is exactly at the oldest kept line', () => {
      for (let i = 0; i < 8; i += 1) hub.publishLine(GUID_A, 'stdout', `line ${i}`);
      const oldest = hub.history(GUID_A, 0).events[0]!.seq;
      expect(hub.history(GUID_A, oldest - 1).gap).toBe(false);
    });

    it('returns nothing for an unknown session', () => {
      expect(hub.history('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0)).toEqual({
        events: [],
        gap: false,
      });
    });
  });

  it('bounds the ring, because a 90 minute export emits thousands of lines', () => {
    for (let i = 0; i < 50; i += 1) hub.publishLine(GUID_A, 'stdout', `line ${i}`);
    const { events } = hub.history(GUID_A, 0);
    expect(events).toHaveLength(5);
    expect(events[0]!.seq).toBe(46);
  });

  it('clear() drops a session lines and its subscribers', () => {
    const seen: RunnerEvent[] = [];
    hub.subscribe(GUID_A, (e) => seen.push(e));
    hub.publishLine(GUID_A, 'stdout', 'before erase');
    hub.clear(GUID_A);
    hub.publishLine(GUID_A, 'stdout', 'after erase');
    expect(hub.history(GUID_A, 0).events).toHaveLength(1);
    // The subscriber set went with the stream, so nothing is delivered, not even
    // to a stale closure that erase should have invalidated.
    expect(seen.map((e) => (e.kind === 'line' ? e.text : 'end'))).toEqual(['before erase']);
    // Sequence numbering restarts, because erase is meant to leave nothing of
    // the old session behind - including its numbering. A GUID is only ever
    // reused by someone who already holds it, so nothing downstream can be
    // confused by the restart.
    expect(hub.lastSeq(GUID_A)).toBe(1);
  });
});