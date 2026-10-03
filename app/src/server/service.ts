import { statfsSync } from 'node:fs';
import {
  ERROR_TEXT,
  type AppEvent,
  type AppErrorCode,
  type NotebookRef,
  type SessionState,
  isValidGuid,
} from '@msout-poc/shared';
import {
  type FlowContext,
  type JobOutcome,
  type JobTrace,
  artifactExists,
  absorbLine,
  judgeCheck,
  judgeExport,
  judgeList,
  judgeLogin,
  newTrace,
} from './flows';
import { JobQueue, type QueueSnapshot } from './queue';
import { type JobStart, RunnerClient, RunnerError } from './runner-client';
import { type JobResult, type LineEvent, isEndEvent, isLineEvent } from './runner-events';
import { SessionStore } from './session-store';
import { SseHub } from './sse';

/**
 * The service layer: everything the routes do, minus HTTP.
 *
 * Kept free of Fastify so the whole flow - create a session, log in, list, export,
 * interrupt, erase - can be tested against a fake runner client with no sockets
 * and no browser.
 */
export interface ServiceDeps {
  store: SessionStore;
  queue: JobQueue;
  runner: RunnerClient;
  sse: SseHub;
  dataRoot: string;
  minFreeDiskMb: number;
  /**
   * How long a `microsoft-webauth check` verdict is treated as current.
   *
   * The preflight launches a browser and loads OneNote, which takes long enough
   * that doing it before every action would double the cost of a small one. A
   * few minutes is short enough that a session Microsoft has just invalidated is
   * caught quickly, and long enough that one check serves a list-then-export
   * sequence. Zero disables caching and checks every time.
   */
  checkPreflightTtlMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
}

/**
 * The minimum a job needs to record and announce its outcome.
 *
 * `emit` is already bound to the session's guid - it takes the event alone.
 * That asymmetry with `Service.emit(guid, event)` is deliberate and was a real
 * bug once: calling the bound one with a guid emitted the guid string as the
 * event, so every outcome notification was silently dropped on the floor.
 */
interface FlowContextLike extends FlowContext {}

/** Why a request was refused, so a route can pick the right status code. */
export class ServiceError extends Error {
  constructor(
    readonly code: AppErrorCode | 'busy' | 'not_found' | 'no_target',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class Service {
  private readonly store: SessionStore;
  private readonly queue: JobQueue;
  private readonly runner: RunnerClient;
  private readonly sse: SseHub;
  private readonly dataRoot: string;
  private readonly minFreeDiskMb: number;
  private readonly checkPreflightTtlMs: number;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  /** Active subscriptions to runner events, keyed by session. */
  private readonly subscriptions = new Map<string, () => void>();

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.queue = deps.queue;
    this.runner = deps.runner;
    this.sse = deps.sse;
    this.dataRoot = deps.dataRoot;
    this.minFreeDiskMb = deps.minFreeDiskMb;
    this.checkPreflightTtlMs = deps.checkPreflightTtlMs ?? 5 * 60_000;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date());
  }

  /* ---------------------------------------------------------------- *
   * Sessions
   * ---------------------------------------------------------------- */

  createSession(guid: string): SessionState {
    if (!isValidGuid(guid)) {
      throw new ServiceError('not_found', 'not a valid guid', 400);
    }
    return this.store.open(guid);
  }

  /** Reads a session, 404 when it is gone. Never creates one. */
  readSession(guid: string): SessionState {
    if (!isValidGuid(guid)) throw new ServiceError('not_found', 'not a valid guid', 400);
    const state = this.store.peek(guid);
    if (!state) throw new ServiceError('not_found', 'no such session', 404);
    return state;
  }

  private patch(guid: string, mutate: (state: SessionState) => void): SessionState {
    return this.store.update(guid, mutate);
  }

  /**
   * Marks a job as running in state.
   *
   * Kept separate from setting the queued position, and only ever moving
   * `queued` to `running`: a job record already carrying the terminal `ended`
   * state belongs to a previous job and must not be revived, or a late update
   * would overwrite the outcome the user is already looking at.
   */
  private markRunning(guid: string, id: string, kind: 'login' | 'check' | 'list' | 'export'): void {
    const now = this.now().toISOString();
    this.patch(guid, (s) => {
      // A late update for a job that has already recorded its outcome is dropped:
      // overwriting it would replace a result the user is looking at with a
      // "running" that is already over.
      //
      // A *different* id is a new job and must be written. An earlier version of
      // this guard rejected any `ended` record, which meant the first job after
      // any finished one could never appear to start - and the preflight check,
      // which always follows a login, never did.
      if (s.job && s.job.id === id && s.job.state === 'ended') return;
      s.job = {
        id,
        kind,
        state: 'running',
        queuedAt: s.job?.queuedAt ?? now,
        startedAt: now,
        endedAt: null,
        position: null,
        error: null,
      };
    });
  }

  private emit(guid: string, event: AppEvent): void {
    this.sse.publish(guid, event);
  }

  /* ---------------------------------------------------------------- *
   * Jobs
   * ---------------------------------------------------------------- */

  /**
   * Runs a job to completion, folding its events into session state.
   *
   * This is the only place that subscribes to the runner, and it unsubscribes
   * when the job ends - a session with no running job has no live stream, so a
   * closed browser tab costs nothing.
   */
  private async runJob(
    guid: string,
    kind: 'login' | 'list' | 'export',
    start: () => Promise<JobStart>,
    judge: (trace: JobTrace, result: JobResult) => JobOutcome,
  ): Promise<void> {
    const trace = newTrace();
    const context = this.flowContext(guid);

    const finish = (result: JobResult) => {
      const outcome = judge(trace, result);
      // The notebook rows live in the trace, not in the outcome, so they are
      // passed separately: the lister's only output is log lines, and the names
      // have to reach the UI from somewhere.
      this.applyOutcome(context, kind, outcome, trace.notebooks.list());
    };

    this.markRunning(guid, this.pendingJobId(guid) ?? `job-${kind}`, kind);
    // Move the feature's own state off `queued` too. Without this the UI would
    // show an export as "queued" for its whole duration while the job was
    // running, and the interrupt button would sit disabled next to it.
    if (kind === 'list') {
      this.patch(guid, (s) => {
        s.notebooks = { ...s.notebooks, state: 'listing' };
      });
      this.emit(guid, { type: 'notebooks', notebooks: this.readSession(guid).notebooks });
    } else if (kind === 'export') {
      this.patch(guid, (s) => {
        s.export = { ...s.export, state: 'running' };
      });
      this.emit(guid, { type: 'export-state', export: this.readSession(guid).export });
    }
    this.emit(guid, { type: 'job-state', job: this.readSession(guid).job });

    let fromSeq = 0;
    try {
      fromSeq = (await start()).fromSeq;
    } catch (error) {
      // The runner refused to start the job at all (busy, no auth, bad target).
      const code = error instanceof RunnerError ? mapRunnerError(error) : 'unknown';
      this.applyOutcome(context, kind, {
        ok: false,
        error: code,
        message: ERROR_TEXT[code],
        partial: false,
      });
      return;
    }

    const result = await this.collect(guid, fromSeq, trace, context);
    finish(result);
  }

  private flowContext(guid: string): FlowContext {
    return {
      guid,
      dataRoot: this.dataRoot,
      patch: (mutate: (state: SessionState) => void) => this.patch(guid, mutate),
      emit: (event: AppEvent) => this.emit(guid, event),
    };
  }

  /**
   * Subscribes to a running job and resolves when it ends.
   *
   * Starts from the sequence the runner reported, not from 0: the stream is per
   * session and its ring still holds the previous job's lines, including that
   * job's `end` event - so a subscription from the beginning would judge the new
   * job finished before it started.
   */
  private collect(
    guid: string,
    fromSeq: number,
    trace: JobTrace,
    context: FlowContext,
  ): Promise<JobResult> {
    return new Promise<JobResult>((resolve) => {
      const unsubscribe = this.runner.subscribe(guid, fromSeq, (event) => {
        if ('kind' in event && event.kind === 'gap') return;
        if (isLineEvent(event)) {
          const line = event as LineEvent;
          this.emit(guid, { type: 'log', seq: line.seq, level: 'info', text: line.text });
          absorbLine(trace, line.text, context);
          this.store.update(guid, (state) => {
            if (line.seq > state.logSeq) state.logSeq = line.seq;
          });
          return;
        }
        if (isEndEvent(event)) {
          unsubscribe();
          resolve(event.result);
        }
      });
      this.subscriptions.set(guid, unsubscribe);
    });
  }

  // Note on abort: the subscription is deliberately *not* torn down here.
  //
  // Asking the runner to stop is not the same as knowing how the job ended, and
  // the end event is what records the outcome - "partial", not "failed". If abort
  // unsubscribed, the promise in runJob would never settle, the queue slot would
  // stay occupied until the runner's own timeout, and every other session would
  // wait behind a job nobody was watching. So abort only signals; the end event
  // still arrives and finishes the job normally.

  private applyOutcome(
    context: FlowContextLike,
    kind: 'login' | 'list' | 'export',
    outcome: JobOutcome,
    /** Collected notebook rows, for a list job. */
    notebooks: NotebookRef[] = [],
  ): void {
    const { guid } = context;
    const now = this.now().toISOString();

    if (kind === 'login') {
      const state = this.patch(guid, (s) => {
        s.job = finishJob(s.job, 'login', now, outcome.error);
        s.mfa = { kind: null, number: null, askedAt: null };
        // `checkedAt` is deliberately left alone: a login does not prove the
        // session live with Microsoft, only that we hold state for it. Only
        // `check` sets that.
        s.auth = outcome.ok
          ? { state: 'valid', email: s.auth.email, at: now, checkedAt: s.auth.checkedAt }
          : { state: 'failed', email: s.auth.email, at: now, checkedAt: s.auth.checkedAt };
        if (outcome.ok) s.export.error = null;
      });
      context.emit({ type: 'auth-state', auth: state.auth, mfa: state.mfa });
    } else if (kind === 'list') {
      const state = this.patch(guid, (s) => {
        s.job = finishJob(s.job, 'list', now, outcome.error);
        s.notebooks = outcome.ok
          ? // The rows the collector gathered, not an empty list: the lister is
            // the only source of notebook names the service has.
            { state: 'loaded', items: notebooks, error: null }
          : { state: 'failed', items: s.notebooks.items, error: outcome.error };
      });
      context.emit({ type: 'notebooks', notebooks: state.notebooks });
    } else {
      const hasArtifact = artifactExists(context);
      const state = this.patch(guid, (s) => {
        s.job = finishJob(s.job, 'export', now, outcome.error);
        s.export.error = outcome.error;
        s.export.partial = outcome.partial;
        s.export.state = outcome.ok ? 'done' : outcome.partial ? 'partial' : 'failed';
        s.export.artifact =
          hasArtifact && (outcome.ok || outcome.partial)
            ? {
                name: s.export.notebook ?? 'notebook',
                bytes: 0,
                partial: outcome.partial,
              }
            : null;
      });
      context.emit({ type: 'export-state', export: state.export });
    }

    // The job ending is announced in its own right, after the record is written.
    // Every other transition is published, and without this a browser learns a
    // job finished only through a side-channel event - and a job with no feature
    // of its own, like the preflight check, would finish silently.
    this.emit(guid, { type: 'job-state', job: this.readSession(guid).job });

    if (!outcome.ok && outcome.error) {
      context.emit({
        type: 'error',
        code: outcome.error,
        message: outcome.message ?? ERROR_TEXT[outcome.error],
      });
    }
  }

  /* ---------------------------------------------------------------- *
   * Public operations
   * ---------------------------------------------------------------- */

  /**
   * Starts a login.
   *
   * `rawCredentials` is the browser's body, forwarded to the runner without being
   * parsed here. This function never reads the email out of it - the state gets
   * its email from the `Attempting automated login for …` log line, which the
   * package emits itself.
   */
  async login(guid: string, rawCredentials: string): Promise<{ jobId: string; position: number }> {
    this.readSession(guid);
    this.assertNoConflict(guid);

    const { id, done } = this.queue.submit(
      {
        kind: 'login',
        run: () =>
          this.runJob(
            guid,
            'login',
            () => this.runner.credentials(guid, rawCredentials),
            (trace, result) => judgeLogin(trace, result, { guid, dataRoot: this.dataRoot }),
          ),
      },
      guid,
    );

    this.patch(guid, (s) => {
      s.job = {
        id,
        kind: 'login',
        state: 'queued',
        queuedAt: this.now().toISOString(),
        startedAt: null,
        endedAt: null,
        position: this.queue.positionOf(id),
        error: null,
      };
      s.auth = { ...s.auth, state: 'logging-in' };
    });
    this.emit(guid, { type: 'job-state', job: this.readSession(guid).job });

    void done.catch(() => {
      /* the outcome is already recorded in state */
    });
    return { jobId: id, position: this.queue.positionOf(id) ?? 1 };
  }

  /** Answers an MFA prompt. Only valid while a login for this session is waiting. */
  async submitMfa(guid: string, code: string): Promise<void> {
    this.readSession(guid);
    try {
      await this.runner.mfa(guid, code);
    } catch (error) {
      if (error instanceof RunnerError && error.code === 'busy') {
        throw new ServiceError('busy', 'no login is waiting for a code', 409);
      }
      throw error;
    }
  }

  async listNotebooks(guid: string): Promise<{ jobId: string; position: number }> {
    const state = this.readSession(guid);
    this.assertSlot(guid, state);
    await this.ensureAuthLive(guid);

    const { id, done } = this.queue.submit(
      {
        kind: 'list',
        run: () =>
          this.runJob(guid, 'list', () => this.runner.list(guid), (trace, result) => judgeList(trace, result)),
      },
      guid,
    );
    this.patch(guid, (s) => {
      s.job = {
        id,
        kind: 'list',
        state: 'queued',
        queuedAt: this.now().toISOString(),
        startedAt: null,
        endedAt: null,
        position: this.queue.positionOf(id),
        error: null,
      };
    });
    this.emit(guid, { type: 'job-state', job: this.readSession(guid).job });
    void done.catch(() => {});
    return { jobId: id, position: this.queue.positionOf(id) ?? 1 };
  }

  async exportNotebook(
    guid: string,
    target: { notebook?: string; notebookUrl?: string },
  ): Promise<{ jobId: string; position: number }> {
    const state = this.readSession(guid);
    if (!target.notebook && !target.notebookUrl) {
      throw new ServiceError('no_target', ERROR_TEXT.no_target, 400);
    }
    if (state.export.state === 'running' || state.export.state === 'queued') {
      throw new ServiceError('busy', 'an export is already running for this session', 409);
    }
    this.assertSlot(guid, state);
    this.assertDisk();
    await this.ensureAuthLive(guid);

    const { id, done } = this.queue.submit(
      {
        kind: 'export',
        run: () =>
          this.runJob(
            guid,
            'export',
            () => this.runner.export(guid, target),
            (trace, result) => judgeExport(trace, result),
          ),
      },
      guid,
    );

    this.patch(guid, (s) => {
      s.job = {
        id,
        kind: 'export',
        state: 'queued',
        queuedAt: this.now().toISOString(),
        startedAt: null,
        endedAt: null,
        position: this.queue.positionOf(id),
        error: null,
      };
      s.export = {
        ...s.export,
        state: 'queued',
        notebook: target.notebook ?? null,
        notebookUrl: target.notebookUrl ?? null,
        pagesExported: 0,
        totalPages: null,
        partial: false,
        error: null,
      };
    });
    this.emit(guid, { type: 'job-state', job: this.readSession(guid).job });
    this.emit(guid, { type: 'export-state', export: this.readSession(guid).export });
    void done.catch(() => {});
    return { jobId: id, position: this.queue.positionOf(id) ?? 1 };
  }

  /**
   * Confirms with Microsoft that this session is still live, on demand.
   *
   * The same work list and export do automatically before they run. Exposed
   * because a user whose export just failed has no way to tell an expired
   * session from a transient error, and "check now" is the honest answer.
   *
   * @throws ServiceError 409 when the session is no longer authenticated.
   */
  async checkAuth(guid: string): Promise<void> {
    this.readSession(guid);
    await this.runPreflightCheck(guid);
  }

  /**
   * Confirms with Microsoft that the session is still live, before an operation
   * that would otherwise fail obscurely.
   *
   * This closes the limitation PLAN-v2 §13.2 named as v1's main known problem: a
   * session that signed in at 10:00 and exported at 12:30 used to present an
   * export error indistinguishable from the crashed-OneNote-tab error the
   * packages document. It became possible only at 0.1.9, when `check` stopped
   * reporting success for a dead session.
   *
   * The verdict is cached briefly, because the check is not free: it launches a
   * browser and loads OneNote.
   *
   * `unverifiable` deliberately does not block the operation. The check failing
   * is not evidence the session is bad, and refusing to export on a DNS blip
   * would be worse than the error it prevents.
   */
  private async ensureAuthLive(guid: string): Promise<void> {
    const state = this.readSession(guid);
    if (state.auth.checkedAt && this.checkPreflightTtlMs > 0) {
      const age = this.now().getTime() - Date.parse(state.auth.checkedAt);
      if (Number.isFinite(age) && age < this.checkPreflightTtlMs) return;
    }
    // A check needs an auth file to check; without one the session is not signed
    // in, which assertSlot has already established cannot be the case.
    await this.runPreflightCheck(guid);
  }

  /** Runs the check and records the verdict. Throws when the session is gone. */
  private async runPreflightCheck(guid: string): Promise<void> {
    const trace = newTrace();
    const context = this.flowContext(guid);
    const state = this.readSession(guid);

    let outcome: JobOutcome;
    try {
      // Through the queue, like every other job. Calling the runner directly
      // would be a bug: two sessions both preflighting at once would both try to
      // claim the runner's single slot, and one would get a 409 it cannot act on.
      const { done } = this.queue.submit(
        {
          kind: 'check',
          run: async () => {
            // The check is a real job and is shown as one: it launches a browser
            // and takes tens of seconds, and a UI that showed nothing would look
            // hung. Marked here rather than at submit time, because this is
            // where the job actually claims the runner's slot.
            this.markRunning(guid, this.pendingJobId(guid) ?? 'job-check', 'check');
            this.emit(guid, { type: 'job-state', job: this.readSession(guid).job });
            const { fromSeq } = await this.runner.check(guid);
            return this.collect(guid, fromSeq, trace, context);
          },
        },
        guid,
      );
      outcome = judgeCheck(trace, await done);
    } catch (error) {
      // The runner would not start the check. Not knowing is not the same as
      // knowing the session is dead, so this is recorded and the operation
      // continues - refusing to export because a check could not run would be a
      // worse failure than the one the preflight exists to prevent.
      this.log(`preflight check could not run for ${guid.slice(0, 8)}…: ${(error as Error).message}`);
      return;
    }
    const now = this.now().toISOString();

    // The check is a real job and says so: it takes a browser launch and tens of
    // seconds, and a UI that showed nothing would look hung.
    this.patch(guid, (st) => {
      st.job = finishJob(st.job, 'check', now, outcome.ok ? null : outcome.error);
    });
    this.emit(guid, { type: 'job-state', job: this.readSession(guid).job });

    if (outcome.ok) {
      this.patch(guid, (st) => {
        st.auth = { ...st.auth, state: 'valid', checkedAt: now };
      });
      this.emit(guid, { type: 'auth-state', auth: this.readSession(guid).auth, mfa: state.mfa });
      return;
    }

    if (outcome.error === 'auth_unverified') {
      // The check itself failed. Recorded so the UI can say so, but it does not
      // sign the user out.
      this.patch(guid, (st) => {
        st.auth = { ...st.auth, checkedAt: now };
      });
      this.emit(guid, { type: 'error', code: 'auth_unverified', message: outcome.message! });
      return;
    }

    // Expired, or there is nothing to log in with: the session is gone. The auth
    // block comes back, and any export already on disk stays downloadable.
    this.patch(guid, (st) => {
      st.auth = { state: 'failed', email: st.auth.email, at: st.auth.checkedAt, checkedAt: now };
      st.notebooks = { state: 'idle', items: st.notebooks.items, error: 'no_auth' };
    });
    const current = this.readSession(guid);
    this.emit(guid, { type: 'auth-state', auth: current.auth, mfa: current.mfa });
    this.emit(guid, {
      type: 'error',
      code: outcome.error ?? 'auth_expired',
      message: outcome.message ?? ERROR_TEXT.auth_expired,
    });
    throw new ServiceError(
      (outcome.error ?? 'auth_expired') as AppErrorCode,
      outcome.message ?? ERROR_TEXT.auth_expired,
      409,
    );
  }

  /** Interrupts the running export. Signals the child; no cooperative cancel exists. */
  async abortExport(guid: string): Promise<boolean> {
    this.readSession(guid);
    try {
      return await this.runner.abort(guid);
    } catch (error) {
      if (error instanceof RunnerError) return false;
      throw error;
    }
  }

  /**
   * Erase: kill, unsubscribe, delete, tombstone.
   *
   * Order matters. The tombstone goes in before the directory is removed, so a
   * request already in flight cannot recreate the session behind the user's back.
   */
  async erase(guid: string): Promise<void> {
    // The session may already be gone; erasing twice must still succeed.
    this.store.isErased(guid) || this.store.open(guid);

    const unsubscribe = this.subscriptions.get(guid);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(guid);
    }
    this.queue.cancelQueuedFor(guid);
    try {
      await this.runner.erase(guid);
    } catch (error) {
      // The runner holding the directory is a problem, but the app's own copy is
      // what decides whether the session is gone. Logging and continuing beats
      // leaving the user with a session that still looks alive.
      this.log(`runner erase failed for ${guid.slice(0, 8)}…: ${(error as Error).message}`);
    }
    this.store.erase(guid);
    this.sse.clear(guid);
    this.emit(guid, { type: 'session-erased' });
  }

  /**
   * Erases a session the sweeper found expired.
   *
   * Goes through the same path as a user-initiated erase, and swallows runner
   * failures: an expired session is deleted whether or not the runner answers,
   * because leaving it because of a network error is the opposite of expiring.
   */
  async expireSession(guid: string): Promise<void> {
    try {
      await this.erase(guid);
    } catch (error) {
      this.log(`failed to erase expired session ${guid.slice(0, 8)}…: ${(error as Error).message}`);
    }
  }

  /** The artifact download URL for this session, as the browser should call it. */
  artifactUrl(guid: string): string {
    const state = this.readSession(guid);
    return this.runner.artifactPath(guid, state.export.notebook, state.export.partial);
  }

  /**
   * Opens the runner's zip stream for a session.
   *
   * Returns the upstream Response so the route can pass the body straight
   * through: buffering a multi-gigabyte export in the app to satisfy a typing
   * convenience would be the single easiest way to take it down.
   */
  async artifactStream(guid: string): Promise<Response> {
    const state = this.readSession(guid);
    const path = this.runner.artifactPath(guid, state.export.notebook, state.export.partial);
    return this.runner.fetchArtifact(path);
  }

  /** Subscribes a browser to a session's event stream. */
  subscribeEvents(
    guid: string,
    lastEventId: number,
    state: () => SessionState,
    sink: { send: (event: AppEvent, id?: number) => void; sendComment: (text: string) => void; close: () => void },
  ): () => void {
    return this.sse.subscribe(guid, lastEventId, state, sink);
  }

  queueSnapshot(): QueueSnapshot {
    return this.queue.snapshot();
  }

  subscriberCount(guid: string): number {
    return this.sse.subscriberCount(guid);
  }

  /* ---------------------------------------------------------------- *
   * Guards
   * ---------------------------------------------------------------- */

  /**
   * Refuses a second job for a session that already has one in flight.
   *
   * Only about concurrency. The authentication requirement is separate and
   * applies only to list and export: requiring it for a login would be circular,
   * since logging in is what establishes it.
   */
  /** The id of this session's job, whether queued or already running. */
  private pendingJobId(guid: string): string | null {
    return this.queue.jobIdFor(guid);
  }

  private assertNoConflict(guid: string): void {
    if (this.queue.hasWorkFor(guid)) {
      throw new ServiceError('busy', 'this session already has a job running', 409);
    }
  }

  /** Additionally requires that this session is authenticated. */
  private assertSlot(guid: string, state: SessionState): void {
    this.assertNoConflict(guid);
    if (state.auth.state !== 'valid') {
      throw new ServiceError('no_auth', ERROR_TEXT.no_auth, 409);
    }
  }

  /**
   * Refuses an export when the host is nearly full.
   *
   * The check is at submission rather than during the export because the failure
   * this prevents is the Docker daemon or the host dying mid-run, and by then it
   * is too late to do anything about it cleanly.
   */
  private assertDisk(): void {
    try {
      const stats = statfsSync(this.dataRoot);
      const freeMb = (stats.bavail * stats.bsize) / (1024 * 1024);
      if (freeMb < this.minFreeDiskMb) {
        throw new ServiceError('low_disk', ERROR_TEXT.low_disk, 507);
      }
    } catch (error) {
      // A statfs failure (missing mount, permissions) is not a licence to start a
      // multi-gigabyte export, but it is also not proof the disk is full.
      if (error instanceof ServiceError) throw error;
      this.log(`could not check free space on ${this.dataRoot}: ${(error as Error).message}`);
    }
  }
}

/**
 * Marks a job record ended.
 *
 * Returns a complete `JobInfo` rather than a partial spread, so a session whose
 * job field was somehow absent still ends up with every field the UI reads -
 * `s.job.id` being undefined would render as a blank job name in the log panel.
 */
function finishJob(
  current: SessionState['job'],
  kind: 'login' | 'check' | 'list' | 'export',
  endedAt: string,
  error: AppErrorCode | null,
): NonNullable<SessionState['job']> {
  return {
    id: current?.id ?? `job-${kind}`,
    kind: current?.kind ?? kind,
    state: 'ended',
    queuedAt: current?.queuedAt ?? endedAt,
    startedAt: current?.startedAt ?? null,
    endedAt,
    position: null,
    error,
  };
}

/** Maps a runner-side refusal onto the app's error vocabulary. */
function mapRunnerError(error: RunnerError): AppErrorCode {
  switch (error.code) {
    case 'no_auth':
      return 'no_auth';
    case 'no_target':
      return 'no_target';
    case 'busy':
      return 'busy';
    default:
      return 'unknown';
  }
}