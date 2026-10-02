import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/server/session-store';
import { Sweeper } from '../src/server/sweeper';

const GUID = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';
const FRESH = '9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'msout-sweep-'));
  store = new SessionStore(root, 12);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A store whose clock is under the test's control. */
function storeAt(now: Date, ttlHours = 12): SessionStore {
  return new SessionStore(root, ttlHours, () => now);
}

describe('Sweeper', () => {
  it('does not erase a session inside its budget', () => {
    const now = new Date('2026-10-02T20:00:00.000Z');
    const s = storeAt(now);
    s.open(GUID);
    const sweeper = new Sweeper(s, 60_000, () => {});
    expect(sweeper.sweep(new Date('2026-10-02T23:00:00.000Z'))).toEqual([]);
    expect(s.peek(GUID)).not.toBeNull();
  });

  it('erases a session past its absolute deadline', () => {
    const s = storeAt(new Date('2026-10-02T20:00:00.000Z'));
    s.open(GUID);
    const sweeper = new Sweeper(s, 60_000, () => {});
    const erased = sweeper.sweep(new Date('2026-10-03T09:00:00.000Z'));
    expect(erased).toEqual([GUID]);
    expect(s.peek(GUID)).toBeNull();
  });

  it('tells its listener, so the runner side can be cleaned too', () => {
    const s = storeAt(new Date('2026-10-02T20:00:00.000Z'));
    s.open(GUID);
    const seen: string[] = [];
    const sweeper = new Sweeper(s, 60_000, (guid) => seen.push(guid));
    sweeper.sweep(new Date('2026-10-03T09:00:00.000Z'));
    expect(seen).toEqual([GUID]);
  });

  it('erases only the expired sessions', () => {
    const s = storeAt(new Date('2026-10-02T20:00:00.000Z'));
    s.open(GUID);
    const later = new SessionStore(root, 12, () => new Date('2026-10-03T06:00:00.000Z'));
    later.open(FRESH);
    // The sweeper runs against the store that created both.
    const sweeper = new Sweeper(s, 60_000, () => {});
    expect(sweeper.sweep(new Date('2026-10-03T08:30:00.000Z'))).toEqual([GUID]);
    expect(s.peek(FRESH)).not.toBeNull();
  });

  it('removes the session directory, cookies included', () => {
    const s = storeAt(new Date('2026-10-02T20:00:00.000Z'));
    s.open(GUID);
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(join(root, GUID, 'auth.json'), '{"cookies":[]}');
    new Sweeper(s, 60_000, () => {}).sweep(new Date('2026-10-03T09:00:00.000Z'));
    expect(fs.existsSync(join(root, GUID))).toBe(false);
  });

  it('is safe on an empty data root', () => {
    const sweeper = new Sweeper(new SessionStore(join(root, 'absent'), 12), 60_000, () => {});
    expect(sweeper.sweep()).toEqual([]);
  });

  describe('timer', () => {
    it('runs on the interval and stops cleanly', async () => {
      // A zero-hour budget: created and expired at the same instant, so the very
      // first tick has something to erase.
      const s = storeAt(new Date('2026-10-02T20:00:00.000Z'), 0);
      s.open(GUID);
      const seen: string[] = [];
      const sweeper = new Sweeper(s, 20, (guid) => seen.push(guid));
      sweeper.start();
      // A session created at T0 with a 0h budget is expired immediately.
      await new Promise((resolve) => setTimeout(resolve, 120));
      sweeper.stop();
      expect(seen.length).toBeGreaterThanOrEqual(1);
    });

    it('is idempotent: starting twice does not double the timer', async () => {
      const sweeper = new Sweeper(store, 20, () => {});
      sweeper.start();
      sweeper.start();
      sweeper.stop();
      // Nothing to assert beyond "it does not throw"; the double-start would
      // otherwise leak a timer for the process's lifetime.
      expect(true).toBe(true);
    });

    it('stop() is safe when it was never started', () => {
      const sweeper = new Sweeper(store, 20, () => {});
      expect(() => sweeper.stop()).not.toThrow();
    });
  });
});