import { existsSync } from 'node:fs';
import {
  ERROR_TEXT,
  type AppErrorCode,
  type AppEvent,
  type SessionState,
  sessionPaths,
} from '@msout-poc/shared';
import { NotebookCollector, classify, errorFromLines, parseLine } from './log-parser';
import type { JobResult } from './runner-events';

/**
 * Job execution: turn runner events into session state.
 *
 * This is where the POC's central compromise lives. The packages would emit
 * `success`/`failed`/`progress` events if they could be modified; they cannot,
 * so their log output is the only evidence available and this module interprets
 * it. Two rules follow, and they are the reason the code is shaped as it is:
 *
 *  1. Success is never inferred from an exit code. `microsoft-webauth login`
 *     exits 0 on a failed login - verified against a real capture - so login
 *     success requires the auth file to exist *and* the success line to have
 *     been seen.
 *  2. Every decision keeps the raw lines. A judgement made from a log line is
 *     only as good as the wording it matched, so `lines` is retained and `unknown`
 *     is a legitimate outcome rather than something to paper over.
 */

/** Everything a running job accumulates, kept for the final verdict. */
export interface JobTrace {
  /** Every line seen, for `errorFromLines`. Bounded: only the tail is kept. */
  lines: string[];
  /** Auth success line seen. */
  sawLoginSuccess: boolean;
  /** 0.1.9: the app was reached but the auth file was not usable. */
  loginStateUnusable: string | null;
  /** `check` confirmed a live session. */
  sawCheckAuthenticated: boolean;
  /** `check` did not confirm one, and the reason it gave. */
  checkReason: string | null;
  sawExportComplete: boolean;
  sawExportPartial: boolean;
  sawExportCrashed: boolean;
  mfaRequested: boolean;
  mfaNumber: string | null;
  notebooks: NotebookCollector;
  pagesExported: number;
  pagesFailed: number | null;
  totalPages: number | null;
  /** Absolute path the exporter reported, before it is checked against the session. */
  reportedOutDir: string | null;
  notebookResolved: string | null;
  availableNotebooks: string[];
}

const MAX_TRACE_LINES = 200;

export function newTrace(): JobTrace {
  return {
    lines: [],
    sawLoginSuccess: false,
    loginStateUnusable: null,
    sawCheckAuthenticated: false,
    checkReason: null,
    sawExportPartial: false,
    sawExportCrashed: false,
    mfaRequested: false,
    mfaNumber: null,
    notebooks: new NotebookCollector(),
    pagesExported: 0,
    pagesFailed: null,
    totalPages: null,
    reportedOutDir: null,
    notebookResolved: null,
    availableNotebooks: [],
    sawExportComplete: false,
  };
}

/** Callbacks a flow needs from its host. */
export interface FlowContext {
  guid: string;
  /** Persists a state change and notifies the UI. */
  patch: (mutate: (state: SessionState) => void) => SessionState;
  /** Emits an SSE event to this session's subscribers. Bound to the guid. */
  emit: (event: AppEvent) => void;
  dataRoot: string;
}

/**
 * Folds one line into a trace, returning a patch when the line changed
 * something the user can see.
 */
export function absorbLine(
  trace: JobTrace,
  raw: string,
  context: FlowContext,
): void {
  const parsed = parseLine(raw);
  const signal = classify(parsed.text);

  // Keep the last MAX_TRACE_LINES. The final verdict is made from these, so
  // holding all of a 30 minute export would be the memory problem.
  trace.lines.push(parsed.text);
  if (trace.lines.length > MAX_TRACE_LINES) trace.lines.shift();

  switch (signal.kind) {
    case 'mfa-code':
      trace.mfaRequested = true;
      context.patch((state) => {
        state.mfa = { kind: 'code', number: null, askedAt: new Date().toISOString() };
      });
      context.emit({
        type: 'mfa-required',
        mfa: { kind: 'code', number: null, askedAt: new Date().toISOString() },
      });
      return;

    case 'mfa-number':
      trace.mfaRequested = true;
      trace.mfaNumber = signal.number;
      context.patch((state) => {
        state.mfa = { kind: 'number', number: signal.number, askedAt: new Date().toISOString() };
      });
      context.emit({
        type: 'mfa-required',
        mfa: { kind: 'number', number: signal.number, askedAt: new Date().toISOString() },
      });
      return;

    case 'login-success':
      trace.sawLoginSuccess = true;
      return;

    case 'login-state-unusable':
      trace.loginStateUnusable = signal.reason;
      return;

    case 'check-authenticated':
      trace.sawCheckAuthenticated = true;
      return;

    case 'check-not-authenticated':
      trace.checkReason = signal.reason;
      return;

    case 'notebooks':
      trace.notebooks.push(parsed.text);
      return;

    case 'files-saved-in':
      // Kept raw here and validated by the caller: this string came out of a
      // log, and the log is not trusted to name a directory.
      trace.reportedOutDir = signal.dir;
      return;

    case 'pages-failed':
      trace.pagesFailed = signal.pages;
      context.patch((state) => {
        state.export.pagesFailed = signal.pages;
      });
      return;

    case 'page-exported':
      trace.pagesExported += 1;
      context.patch((state) => {
        state.export.pagesExported = trace.pagesExported;
      });
      context.emit({
        type: 'export-progress',
        pagesExported: trace.pagesExported,
        totalPages: trace.totalPages,
      });
      return;

    case 'total-pages':
      trace.totalPages = signal.pages;
      context.patch((state) => {
        state.export.totalPages = signal.pages;
      });
      return;

    case 'export-complete':
      trace.sawExportComplete = true;
      return;

    case 'export-partial':
      trace.sawExportPartial = true;
      return;

    case 'export-crashed':
      trace.sawExportCrashed = true;
      return;

    case 'notebook-not-found':
      trace.availableNotebooks = signal.available;
      return;

    case 'login-failed':
    case 'no-auth':
    case 'no-target':
    case 'captcha-required':
    case 'microsoft-blocked':
    case 'total-assets':
    case 'none':
      return;
  }
}

/** The verdict for a job that has just ended. */
export interface JobOutcome {
  /** What the session should now say happened. */
  ok: boolean;
  /** null when the job succeeded. */
  error: AppErrorCode | null;
  /** Human-readable explanation, always shown alongside the log. */
  message: string | null;
  /** Whether the artifact, if any, is incomplete. */
  partial: boolean;
}

/**
 * The login verdict.
 *
 * Success requires the auth file on disk **and** the success line, and that rule
 * is unchanged since 0.1.8 - when it was the only defence, because the package
 * exited 0 on a failed login. Since 0.1.9 the exit code is meaningful and is
 * used as corroboration, but it is not promoted to primary: the cost of being
 * stricter than necessary is nil, and the cost of trusting a package's idea of
 * what exit 0 means is a session that believes it is signed in when it is not.
 */
export function judgeLogin(
  trace: JobTrace,
  result: JobResult,
  session: { guid: string; dataRoot: string },
): JobOutcome {
  const authFile = sessionPaths(session.dataRoot, session.guid).authFile;
  const authFileExists = existsSync(authFile);
  const succeeded = trace.sawLoginSuccess && authFileExists && result.code === 0;

  if (succeeded) {
    return { ok: true, error: null, message: null, partial: false };
  }

  if (result.aborted) {
    return { ok: false, error: 'aborted', message: ERROR_TEXT.aborted, partial: false };
  }
  if (result.timedOut) {
    // The most likely cause by far: an MFA prompt nobody answered. The package
    // swallows the failure internally and waits, which is why the runner kills it
    // on a timeout rather than waiting for a verdict that never comes.
    const code: AppErrorCode = trace.mfaRequested ? 'mfa_timeout' : 'timeout';
    return { ok: false, error: code, message: ERROR_TEXT[code], partial: false };
  }
  if (result.spawnError) {
    return { ok: false, error: 'unknown', message: result.spawnError, partial: false };
  }

  // 0.1.9's specific failure: the signed-in app was reached and the auth file is
  // missing, unparseable or not a Playwright storage state. Reported as `no_auth`
  // because that is what the user has to do about it, rather than as the
  // credential rejection it superficially resembles.
  if (trace.loginStateUnusable) {
    return {
      ok: false,
      error: 'no_auth',
      message: `Microsoft signed you in but saved no usable session state (${trace.loginStateUnusable}). Try signing in again.`,
      partial: false,
    };
  }

  const code = errorFromLines(trace.lines, result.code, 'login');
  return { ok: false, error: code, message: ERROR_TEXT[code], partial: false };
}

/**
 * The verdict for `microsoft-webauth check`.
 *
 * Only trustworthy since 0.1.9, which is why this exists at all: the previous
 * check waited a fixed two seconds and asked whether the URL happened to be a
 * login host, so an empty auth file read as signed in.
 *
 * The reasons are kept distinct because they need different advice. `expired` and
 * `stayed_unauthenticated` both mean "sign in again" - the first because
 * Microsoft said so and the auth file was deleted, the second because the app
 * never rendered and nothing proved the session good. `unverifiable` means the
 * check itself failed, which is usually the network: telling someone their
 * session expired when the server simply could not reach Microsoft would send
 * them round a loop for no reason.
 */
export function judgeCheck(trace: JobTrace, result: JobResult): JobOutcome {
  if (trace.sawCheckAuthenticated && result.code === 0) {
    return { ok: true, error: null, message: null, partial: false };
  }
  if (result.aborted) {
    return { ok: false, error: 'aborted', message: ERROR_TEXT.aborted, partial: false };
  }
  if (result.timedOut) {
    return { ok: false, error: 'auth_unverified', message: ERROR_TEXT.auth_unverified, partial: false };
  }
  if (result.spawnError) {
    return { ok: false, error: 'unknown', message: result.spawnError, partial: false };
  }

  const code = errorFromLines(trace.lines, result.code, 'check');
  return { ok: false, error: code, message: ERROR_TEXT[code], partial: false };
}

export function judgeList(trace: JobTrace, result: JobResult): JobOutcome {
  const found = trace.notebooks.list();
  if (found.length > 0) {
    return { ok: true, error: null, message: null, partial: false };
  }
  if (result.aborted) {
    return { ok: false, error: 'aborted', message: ERROR_TEXT.aborted, partial: false };
  }
  if (result.timedOut) {
    return { ok: false, error: 'timeout', message: ERROR_TEXT.timeout, partial: false };
  }

  const code = errorFromLines(trace.lines, result.code, 'list');
  // An empty successful listing is its own outcome, distinct from a failure:
  // "nothing here" and "listing broke" are different messages.
  const finalCode: AppErrorCode = code === 'unknown' ? 'no_notebooks' : code;
  return { ok: false, error: finalCode, message: ERROR_TEXT[finalCode], partial: false };
}

export function judgeExport(trace: JobTrace, result: JobResult): JobOutcome {
  if (result.aborted) {
    // Killed rather than asked to stop: whatever is on disk is partial by
    // definition, and the artifact must be labelled as such.
    return { ok: false, error: 'aborted', message: ERROR_TEXT.aborted, partial: true };
  }
  if (result.timedOut) {
    return { ok: false, error: 'timeout', message: ERROR_TEXT.timeout, partial: true };
  }
  if (result.spawnError) {
    return { ok: false, error: 'unknown', message: result.spawnError, partial: false };
  }
  if (trace.sawExportCrashed) {
    // `partial: false`, unlike an interrupt: the plan (§6.3) maps this line to
    // `failed`. A dead OneNote tab is not a truncated-but-usable export, it is an
    // export whose remaining pages were never attempted, so it is reported as the
    // failure it is rather than dressed up as a partial success.
    return { ok: false, error: 'crashed', message: ERROR_TEXT.crashed, partial: false };
  }
  if (trace.sawExportPartial) {
    return { ok: false, error: 'export_partial', message: ERROR_TEXT.export_partial, partial: true };
  }
  if (result.code !== 0 && !trace.sawExportComplete) {
    const code = errorFromLines(trace.lines, result.code, 'export');
    return { ok: false, error: code, message: ERROR_TEXT[code], partial: false };
  }
  if (trace.sawExportComplete) {
    return { ok: true, error: null, message: null, partial: false };
  }
  return { ok: false, error: 'unknown', message: ERROR_TEXT.unknown, partial: false };
}

/**
 * Does this session have an artifact to download?
 *
 * Checked on disk rather than trusted from the log, because `Files saved in:` is
 * a log line and the directory is the fact.
 */
export function artifactExists(session: { guid: string; dataRoot: string }): boolean {
  const outDir = sessionPaths(session.dataRoot, session.guid).outDir;
  return existsSync(outDir);
}