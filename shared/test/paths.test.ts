import { describe, expect, it } from 'vitest';
import {
  GUID_RE,
  assertGuid,
  isValidGuid,
  newSessionState,
  sessionPaths,
} from '../src/index';

describe('isValidGuid', () => {
  it('accepts a canonical uuid from crypto.randomUUID', () => {
    expect(isValidGuid('3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b')).toBe(true);
  });

  it('accepts upper case, because crypto sources and humans differ', () => {
    expect(isValidGuid('3F2A9C1E-7B4D-4E8A-9F01-2C3D4E5F6A7B')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7'],
    ['non hex digits', '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6azz'],
    ['no dashes', '3f2a9c1e7b4d4e8a9f012c3d4e5f6a7b'],
    ['braces', '{3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b}'],
    ['trailing newline', '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b\n'],
    ['leading space', ' 3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b'],
    ['dot segment', '../../../etc'],
    ['null bytes', '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b/../../etc'],
    ['absolute path', '/etc/passwd'],
    ['slash inside', '3f2a9c1e-7b4d-4e8a-9f01/2c3d4e5f6a7b'],
    ['dot', '.'],
    ['double dot', '..'],
  ])('rejects %s', (_label, value) => {
    expect(isValidGuid(value)).toBe(false);
  });

  it.each([null, undefined, 42, {}, [], true])('rejects non-string %s', (value) => {
    expect(isValidGuid(value)).toBe(false);
  });
});

describe('assertGuid', () => {
  it('throws on a traversal attempt rather than returning a flag', () => {
    expect(() => assertGuid('../../etc/passwd')).toThrow('not a valid guid');
  });

  it('does not throw for a real guid', () => {
    expect(() => assertGuid('3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b')).not.toThrow();
  });
});

describe('sessionPaths', () => {
  const guid = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';

  it('puts everything one session needs under a single directory', () => {
    const p = sessionPaths('/data', guid);
    expect(p).toEqual({
      dir: `/data/${guid}`,
      authFile: `/data/${guid}/auth.json`,
      authMetaFile: `/data/${guid}/auth-meta.json`,
      logsDir: `/data/${guid}/logs`,
      outDir: `/data/${guid}/out`,
      tmpDir: `/data/${guid}/tmp`,
      homeDir: `/data/${guid}/tmp/home`,
    });
  });

  it('never places a path outside the session directory', () => {
    const p = sessionPaths('/data', guid);
    for (const value of Object.values(p)) {
      expect(value.startsWith(`/data/${guid}/`) || value === `/data/${guid}`).toBe(true);
    }
  });

  it('refuses to build paths for a guid that is not one', () => {
    expect(() => sessionPaths('/data', '../evil')).toThrow('not a valid guid');
    expect(() => sessionPaths('/data', '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b/../..')).toThrow();
  });

  it('is not fooled by a guid that merely contains a valid guid', () => {
    expect(() => sessionPaths('/data', `x${GUID_RE.source}`)).toThrow();
  });
});

describe('newSessionState', () => {
  const guid = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';
  const now = new Date('2026-10-02T20:00:00.000Z');

  it('expires exactly ttlHours after creation', () => {
    const s = newSessionState(guid, now, 12);
    expect(s.createdAt).toBe('2026-10-02T20:00:00.000Z');
    expect(s.expiresAt).toBe('2026-10-03T08:00:00.000Z');
  });

  it('starts with nothing done and no job', () => {
    const s = newSessionState(guid, now, 12);
    expect(s.auth.state).toBe('none');
    expect(s.notebooks.state).toBe('idle');
    expect(s.notebooks.items).toEqual([]);
    expect(s.export.state).toBe('idle');
    expect(s.export.pagesExported).toBe(0);
    expect(s.export.totalPages).toBeNull();
    expect(s.mfa).toEqual({ kind: null, number: null, askedAt: null });
    expect(s.job).toBeNull();
  });

  it('fixes the expiry at creation, so later activity cannot extend it', () => {
    // The property being pinned: expiresAt is derived from `now` and nothing
    // else. There is no "last activity" input at all, so there is no way for an
    // idle session to push its own deadline out. Re-deriving the state at a much
    // later moment yields the same instant for the same ttl.
    const first = newSessionState(guid, now, 12);
    const atElevenPm = newSessionState(guid, new Date('2026-10-02T23:00:00.000Z'), 12);
    expect(first.expiresAt).toBe('2026-10-03T08:00:00.000Z');
    expect(new Date(first.expiresAt).getTime() - now.getTime()).toBe(12 * 3600_000);
    // A different creation instant legitimately gives a different deadline;
    // what matters is that it is creation + ttl and never "now + ttl" at read time.
    expect(new Date(atElevenPm.expiresAt).getTime() - now.getTime()).not.toBe(12 * 3600_000);
  });
});