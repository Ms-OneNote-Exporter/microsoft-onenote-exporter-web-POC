import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import {
  type SessionState,
  isValidGuid,
  newSessionState,
  normaliseSessionState,
  sessionPaths,
} from '@msout-poc/shared';

/**
 * Session state on disk: one `state.json` per GUID.
 *
 * SQLite would be the production answer (PLAN-v2 §2.4). It is not the POC's,
 * because the POC has exactly one writer and never queries: state is read whole
 * on each request and written whole on each change. The file is small, human
 * readable with `cat`, and erasable by deleting one directory - which is the
 * property that matters most for a service holding someone's Microsoft cookies.
 *
 * Writes are atomic (temp file + rename) because a torn state.json read by the
 * sweeper would look like a malformed session and could be treated as expired.
 */

/** Raised when a GUID has no session, or its session is gone. */
export class SessionNotFoundError extends Error {
  constructor(readonly guid: string) {
    // The wording is user-facing: it reaches the browser as the 404 body, and a
    // GUID is opaque to the person who lost it, so "no such session" rather than
    // an internal-sounding message.
    super('no such session');
    this.name = 'SessionNotFoundError';
  }
}

export class SessionStore {
  /**
   * GUIDs deleted during this process's lifetime.
   *
   * A tombstone, because deleting the directory is not enough on its own: a
   * request already queued, or a browser replaying a POST, would otherwise
   * recreate the session directory and resurrect a session the user erased.
   */
  private readonly erased = new Set<string>();

  constructor(
    private readonly dataRoot: string,
    private readonly ttlHours: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Marks a GUID erased and removes its directory. Idempotent. */
  erase(guid: string): void {
    if (!isValidGuid(guid)) return;
    this.erased.add(guid);
    try {
      rmSync(sessionPaths(this.dataRoot, guid).dir, { recursive: true, force: true });
    } catch {
      // The tombstone is the important half: even if the directory could not be
      // removed, the session stays dead and the sweeper will try again.
    }
  }

  isErased(guid: string): boolean {
    return this.erased.has(guid);
  }

  /**
   * Returns the session for a GUID, creating it if absent.
   *
   * Creating on read is deliberate: the landing page generates a GUID and the
   * user may never come back, and an empty session costs one small file.
   */
  open(guid: string): SessionState {
    if (!isValidGuid(guid)) throw new SessionNotFoundError(guid);
    if (this.erased.has(guid)) throw new SessionNotFoundError(guid);

    const paths = sessionPaths(this.dataRoot, guid);
    try {
      const parsed = JSON.parse(readFileSync(`${paths.dir}/state.json`, 'utf8')) as SessionState;
      // A file from an older shape, or a hand-edited one, is not trusted: the
      // session is rebuilt rather than crashing the request that found it.
      if (parsed.guid !== guid) throw new Error('guid mismatch');
      // Not every field has always existed. Session files outlive the build that
      // wrote them, so missing nested fields are filled in rather than left
      // `undefined` for the renderer to trip over.
      return normaliseSessionState(parsed, guid, this.now(), this.ttlHours);
    } catch {
      const state = newSessionState(guid, this.now(), this.ttlHours);
      this.write(state);
      return state;
    }
  }

  /** Reads without creating. Returns null when there is no session. */
  peek(guid: string): SessionState | null {
    if (!isValidGuid(guid) || this.erased.has(guid)) return null;
    try {
      const paths = sessionPaths(this.dataRoot, guid);
      const parsed = JSON.parse(readFileSync(`${paths.dir}/state.json`, 'utf8')) as SessionState;
      return parsed.guid === guid ? normaliseSessionState(parsed, guid, this.now(), this.ttlHours) : null;
    } catch {
      return null;
    }
  }

  write(state: SessionState): void {
    const paths = sessionPaths(this.dataRoot, state.guid);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const target = `${paths.dir}/state.json`;
    const temp = `${target}.tmp`;
    // Owner-only from creation: this directory also holds auth.json.
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  }

  /** Applies a mutation and persists the result. */
  update(guid: string, mutate: (state: SessionState) => SessionState | void): SessionState {
    const current = this.open(guid);
    const next = mutate(current) ?? current;
    this.write(next);
    return next;
  }

  /** True when the session's absolute budget is spent. */
  isExpired(state: SessionState, at: Date = this.now()): boolean {
    return Date.parse(state.expiresAt) <= at.getTime();
  }

  /** Every live GUID, for the sweeper. Unreadable files are skipped, not fatal. */
  listGuids(): string[] {
    const out: string[] = [];
    let entries: string[];
    try {
      // A missing root throws; a POC with no sessions yet is normal, so it is
      // "nothing to sweep" rather than an error.
      entries = readdirSync(this.dataRoot);
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!isValidGuid(entry)) continue;
      if (this.erased.has(entry)) continue;
      if (this.peek(entry)) out.push(entry);
    }
    return out;
  }
}