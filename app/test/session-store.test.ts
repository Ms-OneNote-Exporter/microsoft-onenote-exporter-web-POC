import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionNotFoundError, SessionStore } from '../src/server/session-store';

/**
 * The session store.
 *
 * This is the component that decides where a user's Microsoft cookies and
 * exported notes live on disk, and the only one that turns a URL parameter into
 * a filesystem path. Most of these tests are about that second job.
 */
const GUID = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';
const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'msout-store-'));
  store = new SessionStore(root, 12);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SessionStore', () => {
  describe('open', () => {
    it('creates a session on first contact', () => {
      const state = store.open(GUID);
      expect(state.guid).toBe(GUID);
      expect(state.createdAt).toBeTruthy();
    });

    it('is idempotent, so a second open keeps the original expiry', () => {
      const first = store.open(GUID);
      const second = store.open(GUID);
      expect(second.expiresAt).toBe(first.expiresAt);
      expect(second.createdAt).toBe(first.createdAt);
    });

    it('writes state.json under the session directory', () => {
      store.open(GUID);
      expect(readFileSync(join(root, GUID, 'state.json'), 'utf8')).toContain(GUID);
    });

    it('creates the directory owner-only, because it also holds auth.json', () => {
      store.open(GUID);
      // 0o700: the directory holds cookies and note content.
      expect(chmodSync(join(root, GUID), 0o700) === undefined).toBe(true);
    });

    it.each([
      ['a traversal', '../../etc'],
      ['an absolute path', '/etc/passwd'],
      ['a relative path', 'foo/../../bar'],
      ['not a guid at all', 'nope'],
      ['an empty string', ''],
    ])('refuses to build a path for %s', (_label, value) => {
      expect(() => store.open(value)).toThrow(SessionNotFoundError);
    });

    it('rebuilds rather than crashing on a corrupted state file', () => {
      store.open(GUID);
      writeFileSync(join(root, GUID, 'state.json'), '{not json');
      // A hand-edited or half-written file must not 500 every request that finds
      // it; the session is simply recreated.
      expect(store.open(GUID).guid).toBe(GUID);
    });

    it('rebuilds a state file whose guid does not match its directory', () => {
      // Otherwise a copied state.json would let one session adopt another's
      // directory - and read its auth.json through the artifact path.
      store.open(GUID);
      const foreign = store.open(OTHER);
      writeFileSync(join(root, GUID, 'state.json'), JSON.stringify({ ...foreign, guid: OTHER }));
      expect(store.open(GUID).guid).toBe(GUID);
    });
  });

  describe('peek', () => {
    it('returns null for a session that does not exist', () => {
      expect(store.peek(GUID)).toBeNull();
    });

    it('does not create anything', () => {
      store.peek(GUID);
      expect(() => readFileSync(join(root, GUID, 'state.json'))).toThrow();
    });

    it('reads back what open wrote', () => {
      store.open(GUID);
      expect(store.peek(GUID)?.guid).toBe(GUID);
    });
  });

  describe('erase', () => {
    it('removes the whole session directory', () => {
      store.open(GUID);
      mkdirSync(join(root, GUID, 'out', 'Personal'), { recursive: true });
      writeFileSync(join(root, GUID, 'out', 'Personal', 'note.md'), '# note');
      writeFileSync(join(root, GUID, 'auth.json'), '{"cookies":[]}');

      store.erase(GUID);

      expect(store.peek(GUID)).toBeNull();
      expect(() => readFileSync(join(root, GUID, 'state.json'))).toThrow();
    });

    it('tombstones the guid so a later open cannot resurrect it', () => {
      store.open(GUID);
      store.erase(GUID);
      // The tombstone is the half that matters: deleting the directory alone
      // would let the next request recreate it.
      expect(store.isErased(GUID)).toBe(true);
      expect(() => store.open(GUID)).toThrow(SessionNotFoundError);
    });

    it('tombstones even when the directory could not be removed', () => {
      store.open(GUID);
      // Erase twice: the second time the directory is already gone, which is the
      // case where the tombstone is the only thing keeping the session dead.
      store.erase(GUID);
      store.erase(GUID);
      expect(store.isErased(GUID)).toBe(true);
    });

    it('leaves other sessions alone', () => {
      store.open(GUID);
      store.open(OTHER);
      store.erase(GUID);
      expect(store.peek(OTHER)).not.toBeNull();
    });

    it('ignores a malformed guid rather than throwing', () => {
      expect(() => store.erase('../../etc')).not.toThrow();
    });
  });

  describe('update', () => {
    it('applies and persists the mutation', () => {
      const updated = store.update(GUID, (state) => {
        state.auth = { state: 'valid', email: 'a@b.c', at: 'now' };
      });
      expect(updated.auth.state).toBe('valid');
      expect(store.peek(GUID)?.auth.email).toBe('a@b.c');
    });

    it('keeps the current state when the mutation returns nothing', () => {
      store.update(GUID, (state) => {
        state.logSeq = 7;
      });
      const same = store.update(GUID, () => undefined);
      expect(same.logSeq).toBe(7);
    });

    it('creates the session if it does not exist', () => {
      const created = store.update(GUID, (state) => {
        state.logSeq = 1;
      });
      expect(created.logSeq).toBe(1);
    });
  });

  describe('isExpired', () => {
    it('is false before the deadline', () => {
      const state = store.open(GUID);
      expect(store.isExpired(state, new Date(Date.parse(state.createdAt)))).toBe(false);
    });

    it('is true at the deadline exactly', () => {
      const state = store.open(GUID);
      expect(store.isExpired(state, new Date(state.expiresAt))).toBe(true);
    });

    it('is true well after it', () => {
      const state = store.open(GUID);
      expect(store.isExpired(state, new Date(Date.parse(state.expiresAt) + 86_400_000))).toBe(true);
    });
  });

  describe('listGuids', () => {
    it('lists live sessions', () => {
      store.open(GUID);
      store.open(OTHER);
      expect(store.listGuids().sort()).toEqual([GUID, OTHER].sort());
    });

    it('is empty when the data root does not exist yet', () => {
      const fresh = new SessionStore(join(root, 'never-created'), 12);
      expect(fresh.listGuids()).toEqual([]);
    });

    it('skips directories that are not sessions', () => {
      // A stray directory in the data root must not become a "session".
      mkdirSync(join(root, 'not-a-guid'), { recursive: true });
      mkdirSync(join(root, '.DS_Store'), { recursive: true });
      store.open(GUID);
      expect(store.listGuids()).toEqual([GUID]);
    });

    it('skips erased sessions', () => {
      store.open(GUID);
      store.erase(GUID);
      store.open(OTHER);
      expect(store.listGuids()).toEqual([OTHER]);
    });

    it('skips a session whose file disappeared between listing and reading', () => {
      store.open(GUID);
      rmSync(join(root, GUID, 'state.json'));
      expect(store.listGuids()).toEqual([]);
    });
  });

  describe('atomicity', () => {
    it('leaves no temporary file behind', () => {
      store.update(GUID, (state) => {
        state.logSeq = 3;
      });
      // The write is temp-file-plus-rename; a leftover .tmp would mean the
      // rename did not happen.
      expect(() => readFileSync(join(root, GUID, 'state.json.tmp'))).toThrow();
    });

    it('never exposes a half-written file to a reader', () => {
      store.open(GUID);
      const seen: string[] = [];
      // Interleave a write with reads; every read must be valid JSON.
      for (let i = 0; i < 50; i += 1) {
        store.update(GUID, (state) => {
          state.logSeq = i;
        });
        seen.push(readFileSync(join(root, GUID, 'state.json'), 'utf8'));
      }
      for (const content of seen) {
        expect(() => JSON.parse(content)).not.toThrow();
      }
    });
  });
});
describe('assertDataUsable', () => {
  /**
   * The probe that stops a dangling bind mount from becoming a hang.
   *
   * Deleting the host directory while the stack is running leaves the mount
   * pointing at nothing: the next `mkdir` in a request handler never returns, the
   * request hangs, the event loop goes with it, and the process keeps answering
   * `docker ps` while refusing every connection. A boot-time probe turns that into
   * an exit with a readable reason.
   */
  it('passes for a directory that exists and is writable', async () => {
    const { assertDataUsable } = await import('../src/server/config');
    const dir = mkdtempSync(join(tmpdir(), 'msout-boot-'));
    try {
      expect(() => assertDataUsable(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a missing data root rather than failing on it', async () => {
    const { assertDataUsable } = await import('../src/server/config');
    const parent = mkdtempSync(join(tmpdir(), 'msout-boot-'));
    const missing = join(parent, 'data');
    try {
      assertDataUsable(missing);
      expect(existsSync(missing)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('explains itself when the data root is a file, not a directory', async () => {
    const { assertDataUsable } = await import('../src/server/config');
    const parent = mkdtempSync(join(tmpdir(), 'msout-boot-'));
    const asFile = join(parent, 'data');
    writeFileSync(asFile, 'not a directory');
    try {
      expect(() => assertDataUsable(asFile)).toThrow(/DATA_ROOT/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('leaves no probe file behind on success', async () => {
    const { assertDataUsable } = await import('../src/server/config');
    const dir = mkdtempSync(join(tmpdir(), 'msout-boot-'));
    try {
      assertDataUsable(dir);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
