import { describe, expect, it } from 'vitest';
import {
  GUID_RE,
  assertGuid,
  isValidGuid,
  newSessionState,
  normaliseSessionState,
  relativeInside,
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

describe('relativeInside', () => {
  const OUT = '/data/3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b/out';

  /**
   * This is the check that stands between a line in a log and a directory the
   * file browser will walk. The input is whatever the exporter printed, so it is
   * data, and the output decides which directory gets read.
   */
  it('accepts the real shape the exporter prints', () => {
    expect(relativeInside(OUT, `${OUT}/The Complete Notebook`)).toBe('The Complete Notebook');
  });

  it('accepts a nested path', () => {
    expect(relativeInside(OUT, `${OUT}/Personal/Work`)).toBe('Personal/Work');
  });

  it('reports the root itself as an empty remainder, not as a refusal', () => {
    // '' and null are different answers: one means "walk the output root", the
    // other means "the exporter named somewhere else".
    expect(relativeInside(OUT, OUT)).toBe('');
    expect(relativeInside(OUT, `${OUT}/`)).toBe('');
  });

  it('refuses a sibling directory that shares a name prefix', () => {
    // The bug a string prefix check has: '/data/<guid>' must not accept
    // '/data/<guid>-other', which is a different session's directory.
    const SESSION = '/data/3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';
    expect(relativeInside(`${SESSION}/out`, `${SESSION}/out2/secret`)).toBeNull();
    expect(relativeInside('/data', '/database/x')).toBeNull();
  });

  it('refuses a path that climbs out with ..', () => {
    expect(relativeInside(OUT, `${OUT}/../../3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b`)).toBeNull();
    expect(relativeInside(OUT, '/data')).toBeNull();
    expect(relativeInside(OUT, '/')).toBeNull();
  });

  it('refuses a parent directory outright', () => {
    expect(relativeInside(OUT, '/data/3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b')).toBeNull();
  });

  it('refuses anything that is not a usable string', () => {
    expect(relativeInside(OUT, '')).toBeNull();
    expect(relativeInside(OUT, null)).toBeNull();
    expect(relativeInside(OUT, undefined)).toBeNull();
    expect(relativeInside(OUT, 42)).toBeNull();
    expect(relativeInside(OUT, { toString: () => OUT })).toBeNull();
  });

  it('tolerates noise a real log might carry', () => {
    // Trailing whitespace is stripped by the caller, but double slashes and a
    // leading one are normal in hand-assembled paths and must not change the
    // answer.
    expect(relativeInside(OUT, `${OUT}//Personal//Work`)).toBe('Personal/Work');
    expect(relativeInside(`${OUT}/`, `${OUT}/Personal`)).toBe('Personal');
  });

  it('resolves . segments rather than storing them', () => {
    expect(relativeInside(OUT, `${OUT}/./Personal/./Work`)).toBe('Personal/Work');
  });
});

describe('normaliseSessionState', () => {
  const now = new Date('2026-10-03T12:00:00.000Z');
  const GUID = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';

  /**
   * Session files outlive the build that wrote them. A deploy can add a nested
   * field between one export and the next, and the file on disk is not rewritten
   * until something in it changes.
   */
  it('fills a field an older build never wrote', () => {
    const old = { guid: GUID, export: { state: 'done', pagesExported: 24 } } as never;
    const state = normaliseSessionState(old, GUID, now, 12);
    expect(state.export.pagesExported).toBe(24);
    expect(state.export.pagesFailed).toBeNull();
    expect(state.export.outPath).toBeNull();
  });

  it('keeps the fields that were there', () => {
    const old = {
      guid: GUID,
      export: { state: 'partial', pagesExported: 24, pagesFailed: 2, outPath: 'The Complete Notebook' },
    } as never;
    const state = normaliseSessionState(old, GUID, now, 12);
    expect(state.export).toMatchObject({
      state: 'partial',
      pagesExported: 24,
      pagesFailed: 2,
      outPath: 'The Complete Notebook',
    });
  });

  it('fills a whole missing section without disturbing the others', () => {
    // A shallow spread here would replace `export` wholesale and lose
    // pagesExported, which is the bug this guards.
    const old = { guid: GUID, notebooks: { state: 'loaded', items: [{ name: 'Personal', url: null }] } } as never;
    const state = normaliseSessionState(old, GUID, now, 12);
    expect(state.notebooks.state).toBe('loaded');
    expect(state.notebooks.items).toHaveLength(1);
    expect(state.export.state).toBe('idle');
    expect(state.export.pagesExported).toBe(0);
    expect(state.export.artifact).toBeNull();
  });

  it('refuses to let the file disagree about which session it is', () => {
    // The guid in the file is never allowed to override the one being opened:
    // that is the only thing tying state to a directory.
    const old = { guid: 'ffffffff-2222-3333-4444-555555555555', export: {} } as never;
    expect(normaliseSessionState(old, GUID, now, 12).guid).toBe(GUID);
  });

  it('produces a usable state from nothing at all', () => {
    for (const input of [null, undefined, 42, 'nonsense', [], true]) {
      const state = normaliseSessionState(input, GUID, now, 12);
      expect(state.guid).toBe(GUID);
      expect(state.export.state).toBe('idle');
      expect(new Date(state.expiresAt).getTime()).toBe(now.getTime() + 12 * 3600_000);
    }
  });
});
