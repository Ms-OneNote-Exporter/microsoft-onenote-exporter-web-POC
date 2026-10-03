/**
 * The contract shared by the app, the runner and the browser bundle.
 *
 * Two things live here and nowhere else, on purpose:
 *
 *   1. GUID validation and the session path layout. Both processes build paths
 *      from a value that arrives in a URL, so the function that does it must
 *      have exactly one implementation. Two copies of "join the user's input to
 *      a path" is two chances to get a directory traversal.
 *   2. The state and event shapes. The app writes state.json, the browser
 *      renders it and the SSE hub emits it; if these drift, the UI breaks in a
 *      way no type checker on one side can catch.
 */

/**
 * A GUID as produced by `crypto.randomUUID()`.
 *
 * Matched strictly, case-insensitively, and with no surrounding whitespace: the
 * value is used as a directory name, so anything looser is a hole.
 */
export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns true when `value` is a well-formed GUID. */
export function isValidGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID_RE.test(value);
}

/** Throws unless `value` is a well-formed GUID. Used at every route boundary. */
export function assertGuid(value: unknown): asserts value is string {
  if (!isValidGuid(value)) {
    throw new Error('not a valid guid');
  }
}

/** Absolute paths inside one session directory. */
export interface SessionPaths {
  /** `/data/<guid>` - the session root, and the only thing erase deletes. */
  dir: string;
  /** Written by microsoft-webauth. Its existence is what "logged in" means. */
  authFile: string;
  /** Written by microsoft-webauth next to authFile, as `<name>-meta.json`. */
  authMetaFile: string;
  /** ONENOTE_EXPORT_LOG_DIR for every child of this session. */
  logsDir: string;
  /** `--output-dir` for the export: the markdown + assets tree. */
  outDir: string;
  /** Scratch space: Playwright profile junk, package temp files. */
  tmpDir: string;
  /** HOME for every child, so nothing is written outside the session. */
  homeDir: string;
}

/**
 * Builds every path a session needs from the data root and its GUID.
 *
 * The GUID is validated here rather than at the call sites: there are eight
 * call sites and one rule.
 */
export function sessionPaths(dataRoot: string, guid: string): SessionPaths {
  assertGuid(guid);
  const dir = `${dataRoot}/${guid}`;
  return {
    dir,
    authFile: `${dir}/auth.json`,
    authMetaFile: `${dir}/auth-meta.json`,
    logsDir: `${dir}/logs`,
    outDir: `${dir}/out`,
    tmpDir: `${dir}/tmp`,
    homeDir: `${dir}/tmp/home`,
  };
}

/* ------------------------------------------------------------------ *
 * State: written by the app into <session>/state.json, read by the UI.
 * ------------------------------------------------------------------ */

export type AuthState = 'none' | 'logging-in' | 'valid' | 'failed';
export type ListState = 'idle' | 'queued' | 'listing' | 'loaded' | 'failed';
export type ExportState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'aborted';
export type JobState = 'queued' | 'running' | 'ended';
/**
 * `check` is `microsoft-webauth check`: it asks Microsoft whether the saved
 * session is still live. It exists because 0.1.9 made it trustworthy - it waits
 * for either the signed-in app or a login redirect, exits 1 when it cannot
 * confirm, and only deletes the auth file when Microsoft says expired. Before
 * that, a check could report success for a dead session, which is why the POC
 * deferred it entirely.
 */
export type JobKind = 'login' | 'check' | 'list' | 'export';
export type MfaKind = null | 'code' | 'number';

/** The MFA code/number the user is being asked for, if any. */
export interface MfaState {
  kind: MfaKind;
  /** Set for a number-match challenge. Never set for a code challenge. */
  number: string | null;
  askedAt: string | null;
}

export interface NotebookRef {
  name: string;
  url: string | null;
}

export interface ArtifactState {
  name: string;
  bytes: number;
  partial: boolean;
}

export interface JobInfo {
  id: string;
  kind: JobKind;
  state: JobState;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** 1-based position in the global queue while queued. */
  position: number | null;
  error: AppErrorCode | null;
}

export interface SessionState {
  guid: string;
  createdAt: string;
  /** Absolute. The 12h budget is measured from creation, not from last use. */
  expiresAt: string;
  auth: {
    state: AuthState;
    email: string | null;
    /** When the session last proved itself. */
    at: string | null;
    /**
     * When `microsoft-webauth check` last confirmed the session with Microsoft.
     *
     * The preflight costs a browser launch and a page load, so it is not run
     * before every operation: a verdict younger than the preflight TTL is
     * treated as still current. Null means "never confirmed", which is the state
     * a login leaves behind.
     */
    checkedAt: string | null;
  };
  mfa: MfaState;
  notebooks: {
    state: ListState;
    items: NotebookRef[];
    error: AppErrorCode | null;
  };
  export: {
    state: ExportState;
    notebook: string | null;
    notebookUrl: string | null;
    /** A count, never a percentage: the packages report totals only at the end. */
    pagesExported: number;
    totalPages: number | null;
    partial: boolean;
    error: AppErrorCode | null;
    artifact: ArtifactState | null;
  };
  job: JobInfo | null;
  /** Highest log line sequence this session has emitted. */
  logSeq: number;
}

/** A fresh session, before anything has happened to it. */
export function newSessionState(guid: string, now: Date, ttlHours: number): SessionState {
  return {
    guid,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 3600_000).toISOString(),
    auth: { state: 'none', email: null, at: null, checkedAt: null },
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

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Everything the POC can honestly say about a failure.
 *
 * Each of these is derived from an exit code or a log line the unmodified
 * packages actually emit. There is no `code` from the packages themselves, so
 * `unknown` is the honest default and the raw line is always kept alongside it
 * rather than being discarded.
 */
export type AppErrorCode =
  | 'bad_credentials'
  | 'mfa_timeout'
  | 'captcha_required'
  | 'microsoft_blocked'
  | 'notebook_not_found'
  | 'auth_expired'
  | 'auth_unverified'
  | 'no_target'
  | 'export_failed'
  | 'export_partial'
  | 'aborted'
  | 'no_auth'
  | 'busy'
  | 'low_disk'
  | 'no_notebooks'
  | 'timeout'
  | 'crashed'
  | 'unknown';

export const ERROR_TEXT: Record<AppErrorCode, string> = {
  bad_credentials: 'Microsoft rejected those credentials.',
  mfa_timeout: 'The verification step timed out. Try signing in again.',
  captcha_required: 'Microsoft is asking this server to prove it is human. Try again later, or use the local CLI exporter.',
  microsoft_blocked: 'Microsoft has blocked this server address. Try again later, or use the local CLI exporter.',
  notebook_not_found: 'That notebook is no longer in the list. List notebooks again and pick one.',
  auth_expired: 'Your Microsoft session has expired. Sign in again - your exports are still here.',
  auth_unverified:
    'This server could not confirm your Microsoft session. This is usually a network problem, not a dead session - try again.',
  no_target: 'No notebook was given to export.',
  export_failed: 'The export failed. See the log.',
  export_partial: 'The export finished with errors. What was written is downloadable, but incomplete.',
  aborted: 'Interrupted. What was written before the interruption is available.',
  no_auth: 'Sign in first: there is no auth.json for this session.',
  busy: 'This session already has a job running.',
  low_disk: 'Not enough free disk space on the server to start an export.',
  no_notebooks: 'No notebook was found for this account.',
  timeout: 'The operation took too long and was stopped.',
  crashed: 'The export process died unexpectedly. See the log.',
  unknown: 'Something went wrong. The log has the details.',
};

/* ------------------------------------------------------------------ *
 * Events: app -> browser over SSE
 * ------------------------------------------------------------------ */

/**
 * The POC's event set, deliberately a subset of PLAN-v2 §7.1.
 *
 * Absent from PLAN-v2's list and not replaceable without package changes:
 * per-page structured progress with a known total, `challenge-expired` from the
 * package, and a `snapshot`-less resume.
 */
export type AppEvent =
  | { type: 'snapshot'; state: SessionState }
  | { type: 'auth-state'; auth: SessionState['auth']; mfa: MfaState }
  | { type: 'mfa-required'; mfa: MfaState }
  | { type: 'notebooks'; notebooks: SessionState['notebooks'] }
  | { type: 'job-state'; job: JobInfo | null }
  | { type: 'export-progress'; pagesExported: number; totalPages: number | null }
  | { type: 'export-state'; export: SessionState['export'] }
  | { type: 'log'; seq: number; level: LogLevel; text: string }
  | { type: 'session-erased' }
  | { type: 'error'; code: AppErrorCode; message: string };

export type LogLevel = 'debug' | 'info' | 'step' | 'warn' | 'error';

/** One line of child-process output, as parsed by the app. */
export interface LogLine {
  seq: number;
  ts: string | null;
  level: LogLevel;
  text: string;
  /** The line exactly as emitted, kept so `unknown` failures stay diagnosable. */
  raw: string;
}
/* ------------------------------------------------------------------ *
 * Event stream: when a client may keep asking
 * ------------------------------------------------------------------ */

/**
 * How many times a browser re-opens the event stream before it stops.
 *
 * This number exists because of an observed failure, not a hypothetical one. The
 * first version of the UI reconnected 1.5 s after any error, including the 404
 * it received for a session that did not exist. A single tab left open produced
 * `GET /api/session/events` every two seconds for as long as it stayed open -
 * hundreds of logged requests while the server was otherwise idle - and the tab
 * would have kept it up indefinitely.
 *
 * Six attempts is roughly a minute of trying, which covers a container restart
 * and a brief network drop. Past that the honest answer is "this is not coming
 * back", and the user is told to reload rather than being left watching a
 * session that stopped reporting.
 */
export const MAX_STREAM_RECONNECTS = 6;

/**
 * Delay before the `attempt`-th reconnect, in milliseconds.
 *
 * Linear backoff to a ceiling: linear rather than exponential because the
 * realistic causes are short (a restart, a deploy), and exponential would push
 * the sixth attempt out past a minute, by which point the cap has usually been
 * reached and the user should be told to reload. Capped so that no attempt is
 * more than ten seconds away.
 */
export function streamReconnectDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 1000;
  return Math.min(1000 * Math.floor(attempt), 10_000);
}

/**
 * Whether to re-open the stream after `attempt` consecutive failures.
 *
 * `attempt` is 1-based: pass the count of failures so far. Six failures means
 * stop.
 */
export function shouldReconnect(attempt: number): boolean {
  return Number.isFinite(attempt) && attempt <= MAX_STREAM_RECONNECTS;
}
