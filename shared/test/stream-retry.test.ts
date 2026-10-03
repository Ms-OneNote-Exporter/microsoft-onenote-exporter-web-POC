import { describe, expect, it } from 'vitest';
import {
  MAX_STREAM_RECONNECTS,
  shouldReconnect,
  streamReconnectDelayMs,
} from '../src/index';

describe('the reconnection budget', () => {
  /**
   * The behaviour that was actually wrong in production: a tab left open against
   * a session that does not exist asked for it every 1.5 s, forever.
   */
  it('stops after the configured number of attempts', () => {
    for (let attempt = 1; attempt <= MAX_STREAM_RECONNECTS; attempt += 1) {
      expect(shouldReconnect(attempt)).toBe(true);
    }
    expect(shouldReconnect(MAX_STREAM_RECONNECTS + 1)).toBe(false);
    expect(shouldReconnect(1000)).toBe(false);
  });

  it('never asks more often than once a second', () => {
    expect(streamReconnectDelayMs(1)).toBe(1000);
  });

  it('backs off with each attempt', () => {
    expect(streamReconnectDelayMs(1)).toBeLessThan(streamReconnectDelayMs(2));
    expect(streamReconnectDelayMs(2)).toBeLessThan(streamReconnectDelayMs(3));
  });

  it('never waits more than ten seconds', () => {
    // 10 s is reached exactly at the tenth attempt, which is the last one the
    // budget allows, so in practice nothing ever waits longer than 10 s.
    expect(streamReconnectDelayMs(10)).toBe(10_000);
    expect(streamReconnectDelayMs(600)).toBe(10_000);
  });

  it('treats a nonsense attempt number as the first attempt', () => {
    // A tab must never end up in a state where it cannot reconnect at all,
    // which is what a NaN or a negative count would produce if it passed through.
    expect(streamReconnectDelayMs(0)).toBe(1000);
    expect(streamReconnectDelayMs(-3)).toBe(1000);
    expect(streamReconnectDelayMs(Number.NaN)).toBe(1000);
    expect(shouldReconnect(0)).toBe(true);
  });

  it('covers a restart inside the budget', () => {
    // What the budget is actually for: a container restart takes a few seconds.
    let wait = 0;
    let attempt = 0;
    while (shouldReconnect(attempt + 1)) {
      attempt += 1;
      wait += streamReconnectDelayMs(attempt);
    }
    expect(attempt).toBe(MAX_STREAM_RECONNECTS);
    // Roughly a minute - long enough for a restart, short enough that a user
    // does not sit there for minutes before being told to reload.
    expect(wait).toBeGreaterThan(20_000);
    expect(wait).toBeLessThan(90_000);
  });
});
