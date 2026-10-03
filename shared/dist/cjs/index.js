"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ERROR_TEXT = exports.GUID_RE = void 0;
exports.isValidGuid = isValidGuid;
exports.assertGuid = assertGuid;
exports.sessionPaths = sessionPaths;
exports.newSessionState = newSessionState;
/**
 * A GUID as produced by `crypto.randomUUID()`.
 *
 * Matched strictly, case-insensitively, and with no surrounding whitespace: the
 * value is used as a directory name, so anything looser is a hole.
 */
exports.GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** @returns true when `value` is a well-formed GUID. */
function isValidGuid(value) {
    return typeof value === 'string' && exports.GUID_RE.test(value);
}
/** Throws unless `value` is a well-formed GUID. Used at every route boundary. */
function assertGuid(value) {
    if (!isValidGuid(value)) {
        throw new Error('not a valid guid');
    }
}
/**
 * Builds every path a session needs from the data root and its GUID.
 *
 * The GUID is validated here rather than at the call sites: there are eight
 * call sites and one rule.
 */
function sessionPaths(dataRoot, guid) {
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
/** A fresh session, before anything has happened to it. */
function newSessionState(guid, now, ttlHours) {
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
exports.ERROR_TEXT = {
    bad_credentials: 'Microsoft rejected those credentials.',
    mfa_timeout: 'The verification step timed out. Try signing in again.',
    captcha_required: 'Microsoft is asking this server to prove it is human. Try again later, or use the local CLI exporter.',
    microsoft_blocked: 'Microsoft has blocked this server address. Try again later, or use the local CLI exporter.',
    notebook_not_found: 'That notebook is no longer in the list. List notebooks again and pick one.',
    auth_expired: 'Your Microsoft session has expired. Sign in again - your exports are still here.',
    auth_unverified: 'This server could not confirm your Microsoft session. This is usually a network problem, not a dead session - try again.',
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
