import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import { isValidGuid, sessionPaths } from '@msout-poc/shared';
import { dirSize, safeZipName, zipDir } from './artifact';
import { type RunnerConfig, cliEntry, loadConfig } from './config';
import { EventHub } from './events';
import { JobBusyError, JobManager, SpawnError } from './jobs';

const PKGS: Record<'login' | 'check' | 'list' | 'export', string> = {
  // `check` runs from the same binary as `login`: `microsoft-webauth check`.
  login: '@msout/microsoft-webauth',
  check: '@msout/microsoft-webauth',
  list: '@msout/microsoft-onenote-list-notebooks',
  export: '@msout/microsoft-onenote-export-notebook',
};

/** Hard cap on a credential body. A login is two short fields; 4 KB is generous. */
const CREDENTIAL_BODY_LIMIT = 4096;

/**
 * Resolves a fake CLI script for both execution modes: `tsc` output is `.js` in
 * dist/, while `tsx` runs the `.ts` sources directly.
 */
function resolveScript(name: 'login' | 'check' | 'list' | 'export'): string {
  const js = join(__dirname, 'fake', `${name}.js`);
  return existsSync(js) ? js : join(__dirname, 'fake', `${name}.ts`);
}

/**
 * The CLI entry point to execute.
 *
 * In normal operation this is the installed package's own `main`, so the pinned
 * version in package.json decides where the entry point is. In fake mode it is
 * the local stand-in that emits the same log lines.
 */
/**
 * The command to execute for a job kind.
 *
 * `kind` is the single argument, deliberately: the check used to be spawned with
 * the login's entry point, which happens to be the same binary in production -
 * `microsoft-webauth login` and `microsoft-webauth check` - so the bug was
 * invisible against the real package and only showed up in fake mode, where the
 * two resolve to different scripts and the check silently performed a login.
 */
function entryFor(config: RunnerConfig, kind: 'login' | 'check' | 'list' | 'export'): string {
  return isFakeMode(config) ? resolveScript(kind) : cliEntry(PKGS[kind]);
}

/** Env helpers, kept here so tests can flip fake mode without a reboot. */
function readFake(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.MSOUT_FAKE ?? '').trim().toLowerCase(),
  );
}

/**
 * Tests flip MSOUT_FAKE per case; production sets it once in compose. The
 * override wins if present so a test can exercise both paths against one config.
 */
function isFakeMode(config: RunnerConfig): boolean {
  return process.env.MSOUT_FAKE === undefined ? config.fake : readFake();
}

export function buildApp(deps: { config: RunnerConfig }) {
  const { config } = deps;
  const app = Fastify({
    logger: { level: process.env.RUNNER_LOG_LEVEL ?? 'info' },
    // This process handles credentials. A body that arrives without a declared
    // content type is refused rather than guessed at.
    bodyLimit: CREDENTIAL_BODY_LIMIT,
  });
  const hub = new EventHub(config.ringSize);
  const jobs = new JobManager(hub, config);

  // The credential body is forwarded verbatim from the browser by the app and
  // parsed *here*, in the only process that is allowed to hold a password. No
  // JSON parser is attached to this content type beyond "give me the bytes".
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'string', bodyLimit: CREDENTIAL_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    if (req.headers['x-runner-token'] !== config.token) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true, fake: isFakeMode(config), busy: jobs.busy }));

  app.get('/events', async (req, reply) => {
    const query = req.query as { guid?: string; since?: string };
    const guid = query.guid ?? '';
    if (!isValidGuid(guid)) return reply.code(400).send({ error: 'bad guid' });
    const since = Number.parseInt(query.since ?? '0', 10) || 0;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells any reverse proxy not to buffer the stream. Harmless when there
      // is no proxy in front, which is the POC's normal case.
      'x-accel-buffering': 'no',
    });

    const write = (event: unknown, id?: number) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`);
    };

    const { events, gap } = hub.history(guid, since);
    // A gap means the caller asked for lines that have already aged out of the
    // ring. Saying so is what stops the app from showing a replay that looks
    // continuous but is missing the middle.
    if (gap) write({ kind: 'gap' });
    for (const event of events) write(event, event.seq);

    const unsubscribe = hub.subscribe(guid, (event) => write(event, event.seq));
    const keepalive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': keepalive\n\n');
    }, 15_000);

    req.raw.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  /**
   * Starts a login. The body is the browser's bytes, forwarded untouched by the
   * app: `{"email": "...", "password": "..."}` and nothing else.
   */
  app.post('/sessions/:guid/credentials', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    // The body arrives as an unparsed string: this content type has a parser
    // that only hands over the bytes (see addContentTypeParser above).
    const body: unknown = req.body;
    const paths = safePaths(config, guid);
    if (!paths) return reply.code(400).send({ error: 'bad guid' });
    if (jobs.busy) return busyReply(reply, jobs);

    const parsed = parseCredentials(body);
    if (!parsed) return reply.code(400).send({ error: 'credentials must be {"email","password"}' });
    const { email, password } = parsed;

    // The sequence this job's output starts after. The app subscribes with it so
    // it receives this job's lines and not the tail of the previous one: the event
    // stream is per session, and its ring buffer still holds the last job's
    // lines including its `end` event.
    const fromSeq = hub.lastSeq(guid);

    try {
      jobs.start({
        guid,
        kind: 'login',
        command: process.execPath,
        args: [
          entryFor(config, 'login'),
          'login',
          '--email',
          email,
          '--password',
          password,
          '--auth-file',
          paths.authFile,
        ],
        cwd: paths.dir,
        timeoutMs: config.loginTimeoutMs,
      });
    } catch (err) {
      return startErrorReply(reply, err);
    }

    // 202: the login runs for minutes. The browser watches /events.
    return reply.code(202).send({ started: true, fromSeq });
  });

  /**
   * Asks Microsoft whether the saved session is still live.
   *
   * Only usable since 0.1.9: before it, `check` reported success for a dead
   * session. It costs a browser launch and a page load, so the app calls it as a
   * preflight rather than before every action, and the verdict is only worth
   * what the exit code and the two log lines say - both of which 0.1.9 fixed.
   */
  app.post('/sessions/:guid/check', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    const paths = safePaths(config, guid);
    if (!paths) return reply.code(400).send({ error: 'bad guid' });
    if (jobs.busy) return busyReply(reply, jobs);
    if (!existsSync(paths.authFile)) {
      return reply.code(409).send({ error: 'no_auth', message: 'auth.json is missing' });
    }

    const fromSeq = hub.lastSeq(guid);
    try {
      jobs.start({
        guid,
        kind: 'check',
        command: process.execPath,
        args: [entryFor(config, 'check'), 'check', '--auth-file', paths.authFile],
        cwd: paths.dir,
        timeoutMs: config.checkTimeoutMs,
      });
    } catch (err) {
      return startErrorReply(reply, err);
    }
    return reply.code(202).send({ started: true, fromSeq });
  });

  app.post('/sessions/:guid/mfa', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    if (!safePaths(config, guid)) return reply.code(400).send({ error: 'bad guid' });
    const { code } = req.body as { code?: string };
    if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
      return reply.code(400).send({ error: 'code must be a short string' });
    }
    if (!jobs.acceptsStdin(guid)) {
      return reply.code(409).send({ error: 'no login waiting for input' });
    }
    const ok = jobs.sendStdin(guid, code);
    return reply.code(ok ? 200 : 409).send({ sent: ok });
  });

  app.post('/sessions/:guid/list', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    const paths = safePaths(config, guid);
    if (!paths) return reply.code(400).send({ error: 'bad guid' });
    if (jobs.busy) return busyReply(reply, jobs);
    if (!existsSync(paths.authFile)) {
      return reply.code(409).send({ error: 'no_auth', message: 'auth.json is missing' });
    }
    const fromSeq = hub.lastSeq(guid);
    try {
      jobs.start({
        guid,
        kind: 'list',
        command: process.execPath,
        args: [entryFor(config, 'list'), 'list', '--auth-file', paths.authFile],
        cwd: paths.dir,
        timeoutMs: config.listTimeoutMs,
      });
    } catch (err) {
      return startErrorReply(reply, err);
    }
    return reply.code(202).send({ started: true, fromSeq });
  });

  app.post('/sessions/:guid/export', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    const paths = safePaths(config, guid);
    if (!paths) return reply.code(400).send({ error: 'bad guid' });
    if (jobs.busy) return busyReply(reply, jobs);
    if (!existsSync(paths.authFile)) {
      return reply.code(409).send({ error: 'no_auth', message: 'auth.json is missing' });
    }
    const { notebook, notebookUrl } = req.body as { notebook?: string; notebookUrl?: string };
    if (!notebook && !notebookUrl) {
      return reply.code(400).send({ error: 'no_target', message: 'notebook or notebookUrl required' });
    }

    const args = [
      entryFor(config, 'export'),
      'export',
      '--auth-file',
      paths.authFile,
      '--output-dir',
      paths.outDir,
      '--non-interactive',
    ];
    // URL first: it identifies the notebook exactly, where a name has to match
    // against the list and can collide.
    if (notebookUrl) args.push('--notebook-link', notebookUrl);
    else args.push('--notebook', notebook as string);

    const fromSeq = hub.lastSeq(guid);
    try {
      jobs.start({
        guid,
        kind: 'export',
        command: process.execPath,
        args,
        cwd: paths.dir,
        timeoutMs: config.exportTimeoutMs,
      });
    } catch (err) {
      return startErrorReply(reply, err);
    }
    return reply.code(202).send({ started: true, fromSeq });
  });

  app.post('/sessions/:guid/abort', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    if (!safePaths(config, guid)) return reply.code(400).send({ error: 'bad guid' });
    const aborted = jobs.abort(guid);
    return reply.code(aborted ? 200 : 409).send({ aborted });
  });

  /**
   * Streams a zip of the exported notebook.
   *
   * Streamed, never buffered: a multi-gigabyte notebook through `JSON.stringify`
   * would be the single easiest way to take the runner down.
   */
  app.get('/artifact', async (req, reply) => {
    const query = req.query as { guid?: string; notebook?: string; partial?: string };
    const paths = safePaths(config, query.guid ?? '');
    if (!paths) return reply.code(400).send({ error: 'bad guid' });

    const archive = zipDir(paths.outDir);
    if (!archive) {
      return reply.code(404).send({ error: 'nothing exported yet for this session' });
    }
    const partial = query.partial === '1' || query.partial === 'true';
    const name = safeZipName(query.notebook ?? '', partial, new Date());
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${name}"`);
    // The size is a courtesy for the UI; the stream itself is authoritative.
    reply.header('x-uncompressed-bytes', String(dirSize(paths.outDir)));
    return reply.send(archive);
  });

  app.get('/artifact/size', async (req, reply) => {
    const query = req.query as { guid?: string };
    const paths = safePaths(config, query.guid ?? '');
    if (!paths) return reply.code(400).send({ error: 'bad guid' });
    return { bytes: dirSize(paths.outDir) };
  });

  /** Erase: the runner's half of it. The app forgets the session afterwards. */
  app.delete('/sessions/:guid', async (req, reply) => {
    const { guid } = req.params as { guid: string };
    const paths = safePaths(config, guid);
    if (!paths) return reply.code(400).send({ error: 'bad guid' });
    jobs.abort(guid);
    hub.clear(guid);
    await rm(paths.dir, { recursive: true, force: true });
    return { erased: true };
  });

  return { app, hub, jobs };
}

function safePaths(config: RunnerConfig, guid: string) {
  if (!isValidGuid(guid)) return null;
  return sessionPaths(config.dataRoot, guid);
}

function busyReply(reply: FastifyReply, jobs: JobManager) {
  return reply.code(409).send({ error: 'busy', running: jobs.describeActive() });
}

function startErrorReply(reply: FastifyReply, err: unknown) {
  if (err instanceof JobBusyError) return reply.code(409).send({ error: 'busy' });
  if (err instanceof SpawnError) return reply.code(500).send({ error: err.message });
  return reply.code(500).send({ error: (err as Error).message });
}

/** Parses the forwarded credential body. Never logs what it found. */
function parseCredentials(
  body: unknown,
): { email: string; password: string } | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { email, password } = value as Record<string, unknown>;
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) return null;
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return null;
  return { email, password };
}

/** Entry point. `buildApp` is exported so tests can drive it without binding a port. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const { app } = buildApp({ config });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(
    { fake: config.fake, dataRoot: config.dataRoot },
    'runner listening - this process receives passwords; it is never published to the host',
  );
}

// Only listen when run directly, so importing this module in a test is inert.
if (require.main === module) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}