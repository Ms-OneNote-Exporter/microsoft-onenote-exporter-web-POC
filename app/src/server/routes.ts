import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { isValidGuid, sessionPaths } from '@msout-poc/shared';
import type { AppConfig } from './config';
import { Service, ServiceError } from './service';
import { SessionNotFoundError } from './session-store';

/**
 * HTTP surface.
 *
 * Two rules run through every route here:
 *
 *  - The credential route does not parse its body. It is a byte pipe: the
 *    browser's bytes go to the runner untouched, so no layer above the runner
 *    ever holds a password as a field. The route also never logs the body.
 *  - A GUID from a URL is validated before it is used to build a path. The
 *    session store would reject it anyway; refusing at the boundary keeps the
 *    failure a 400 rather than a 404 with an ambiguous cause.
 */
/**
 * Hard cap on a credential body. A login is an email and a password; 4 KB is
 * generous, and anything larger is refused before it is forwarded.
 */
const CREDENTIAL_BODY_LIMIT = 4096;

export async function buildServer(config: AppConfig, service: Service) {
  const app = Fastify({
    logger: { level: config.logLevel },
    // A session page is a handful of fields. The credential cap is enforced by
    // the route as well, because bodyLimit's error is generic.
    bodyLimit: 64 * 1024,
  });

  /**
   * The credential content type: a pass-through that hands the route the raw
   * string and nothing else.
   *
   * No JSON parser is attached to it, which is the entire point. The browser
   * builds the body; this process forwards the bytes to the runner without ever
   * decoding them, so a password is never a field in a JavaScript object on the
   * machine that is reachable from the network. The cap is 4 KB, because a login
   * is two short values.
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'string', bodyLimit: CREDENTIAL_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  const guidOf = (req: FastifyRequest): string | null => {
    const raw = (req.query as { guid?: string }).guid ?? (req.params as { guid?: string }).guid;
    return isValidGuid(raw) ? raw : null;
  };

  /** Maps a service refusal to a status code and a body the UI can read. */
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof ServiceError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof SessionNotFoundError) {
      // A tombstoned GUID is not "nothing to do here", it is a session that used
      // to exist: the difference matters to the UI, which tells the user their
      // session was erased rather than that the request was malformed.
      return reply.code(404).send({ error: 'not_found', message: 'no such session' });
    }
    app.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: 'unknown', message: 'Something went wrong.' });
  };

  app.get('/healthz', async () => ({
    ok: true,
    queue: service.queueSnapshot(),
  }));

  /**
   * Donation targets.
   *
   * Served from a file committed to the repository rather than from an env var,
   * so the addresses that receive money are auditable in `git` history. See
   * DONATE.md.
   */
  app.get('/api/donate', async () => {
    try {
      const raw = readFileSync(config.donateConfigPath, 'utf8');
      return JSON.parse(raw) as unknown;
    } catch {
      // The config is copied into the image next to the server; if it is missing
      // the page degrades to an explanation instead of failing.
      return { fiat: [], crypto: [], missing: true };
    }
  });

  /* ---------------- sessions ---------------- */

  app.get('/api/session', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    try {
      return service.readSession(guid);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    try {
      return reply.code(201).send(service.createSession(guid));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/session', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    try {
      await service.erase(guid);
      return { erased: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---------------- jobs ---------------- */

  /**
   * Credentials: raw stream forward.
   *
   * `application/octet-stream` is registered as a pass-through parser, so
   * `req.body` is a string this route never inspects. The size cap is applied
   * here as well as by Fastify, because a 4 KB login that arrives as 40 MB
   * should be refused with an explanation rather than a framework error page.
   */
  app.post('/api/session/credentials', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    const body = req.body as unknown;
    if (typeof body !== 'string' || body.length === 0) {
      return reply.code(400).send({ error: 'empty body' });
    }
    if (Buffer.byteLength(body) > CREDENTIAL_BODY_LIMIT) {
      return reply.code(413).send({ error: 'credentials too large' });
    }
    try {
      const accepted = await service.login(guid, body);
      // 202: the login runs for minutes. The browser watches /api/session/events.
      return reply.code(202).send(accepted);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/mfa', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    const { code } = req.body as { code?: unknown };
    if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
      return reply.code(400).send({ error: 'code must be a short string' });
    }
    try {
      await service.submitMfa(guid, code);
      return { sent: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/list', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    try {
      return reply.code(202).send(await service.listNotebooks(guid));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/export', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    const body = req.body as { notebook?: unknown; notebookUrl?: unknown };
    const notebook = typeof body?.notebook === 'string' ? body.notebook : undefined;
    const notebookUrl = typeof body?.notebookUrl === 'string' ? body.notebookUrl : undefined;
    try {
      return reply.code(202).send(await service.exportNotebook(guid, { notebook, notebookUrl }));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/session/abort', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    try {
      return { aborted: await service.abortExport(guid) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /* ---------------- events ---------------- */

  app.get('/api/session/events', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });

    // The browser reconnects with the last id it saw; the header wins over the
    // query parameter because it is what EventSource sets automatically.
    const headerId = Number.parseInt(
      (req.headers['last-event-id'] as string | undefined) ?? '',
      10,
    );
    const queryId = Number.parseInt((req.query as { since?: string }).since ?? '', 10);
    const lastEventId = Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0;

    let state;
    try {
      state = () => service.readSession(guid);
    } catch (error) {
      return fail(reply, error);
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: unknown, id?: number): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = service.subscribeEvents(guid, lastEventId, state, {
      send,
      sendComment: (text) => {
        if (!reply.raw.writableEnded) reply.raw.write(`: ${text}\n\n`);
      },
      close: () => reply.raw.end(),
    });

    req.raw.on('close', unsubscribe);
  });

  /* ---------------- artifact ---------------- */

  /**
   * Streams the export zip from the runner.
   *
   * Proxied rather than redirected so the runner's address and token never
   * reach the browser, and so the download can be authorised per request.
   */
  app.get('/api/session/artifact', async (req, reply) => {
    const guid = guidOf(req);
    if (!guid) return reply.code(400).send({ error: 'bad guid' });
    let state;
    try {
      state = service.readSession(guid);
    } catch (error) {
      return fail(reply, error);
    }
    if (state.export.state !== 'done' && state.export.state !== 'partial') {
      return reply.code(409).send({ error: 'no_artifact', message: 'Nothing has been exported yet.' });
    }
    if (!existsSync(sessionPaths(config.dataRoot, guid).outDir)) {
      return reply.code(404).send({ error: 'no_artifact' });
    }
    const upstream = await service.artifactStream(guid);
    if (!upstream.ok || !upstream.body) {
      return reply.code(502).send({ error: 'runner_unreachable' });
    }
    reply.header('content-type', 'application/zip');
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) reply.header('content-disposition', disposition);
    // Streamed, not buffered: a multi-gigabyte notebook read into a Buffer here
    // would be the easiest way to take the app down.
    return reply.send(Readable.fromWeb(upstream.body as never));
  });

  /* ---------------- web UI ---------------- */

  const indexHtml = join(config.webRoot, 'index.html');
  if (existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: config.webRoot, index: false });

    // The landing page and the session page are the same document; the client
    // router decides which to render from the path. Serving one HTML file for
    // both keeps relative asset paths working (vite is built with base './').
    const sendIndex = (_req: FastifyRequest, reply: FastifyReply) =>
      reply.type('text/html').sendFile('index.html');

    app.get('/', sendIndex);
    app.get('/s/:guid', sendIndex);
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send(
        '<h1>UI not built</h1><p>Run <code>npm run build -w @msout-poc/app</code>, or use the Vite dev server.</p>',
      ),
    );
  }

  return app;
}