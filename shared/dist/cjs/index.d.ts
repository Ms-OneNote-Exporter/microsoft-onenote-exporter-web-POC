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
export declare const GUID_RE: RegExp;
/** @returns true when `value` is a well-formed GUID. */
export declare function isValidGuid(value: unknown): value is string;
/** Throws unless `value` is a well-formed GUID. Used at every route boundary. */
export declare function assertGuid(value: unknown): asserts value is string;
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
export declare function sessionPaths(dataRoot: string, guid: string): SessionPaths;
export type AuthState = 'none' | 'logging-in' | 'valid' | 'failed';
export type ListState = 'idle' | 'queued' | 'listing' | 'loaded' | 'failed';
export type ExportState = 'idle' | 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'aborted';
export type JobState = 'queued' | 'running' | 'ended';
export type JobKind = 'login' | 'list' | 'export';
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
        at: string | null;
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
export declare function newSessionState(guid: string, now: Date, ttlHours: number): SessionState;
/**
 * Everything the POC can honestly say about a failure.
 *
 * Each of these is derived from an exit code or a log line the unmodified
 * packages actually emit. There is no `code` from the packages themselves, so
 * `unknown` is the honest default and the raw line is always kept alongside it
 * rather than being discarded.
 */
export type AppErrorCode = 'bad_credentials' | 'mfa_timeout' | 'captcha_required' | 'microsoft_blocked' | 'notebook_not_found' | 'no_target' | 'export_failed' | 'export_partial' | 'aborted' | 'no_auth' | 'busy' | 'low_disk' | 'no_notebooks' | 'timeout' | 'crashed' | 'unknown';
export declare const ERROR_TEXT: Record<AppErrorCode, string>;
/**
 * The POC's event set, deliberately a subset of PLAN-v2 §7.1.
 *
 * Absent from PLAN-v2's list and not replaceable without package changes:
 * per-page structured progress with a known total, `challenge-expired` from the
 * package, and a `snapshot`-less resume.
 */
export type AppEvent = {
    type: 'snapshot';
    state: SessionState;
} | {
    type: 'auth-state';
    auth: SessionState['auth'];
    mfa: MfaState;
} | {
    type: 'mfa-required';
    mfa: MfaState;
} | {
    type: 'notebooks';
    notebooks: SessionState['notebooks'];
} | {
    type: 'job-state';
    job: JobInfo | null;
} | {
    type: 'export-progress';
    pagesExported: number;
    totalPages: number | null;
} | {
    type: 'export-state';
    export: SessionState['export'];
} | {
    type: 'log';
    seq: number;
    level: LogLevel;
    text: string;
} | {
    type: 'session-erased';
} | {
    type: 'error';
    code: AppErrorCode;
    message: string;
};
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
