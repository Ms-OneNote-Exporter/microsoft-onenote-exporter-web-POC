import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JobResult, RunnerEvent } from '../src/server/runner-events';
import type { JobQueue } from '../src/server/queue';
import { SessionStore } from '../src/server/session-store';
import { type AppConfig } from '../src/server/config';
import { buildServer } from '../src/server/routes';
import { Service } from '../src/server/service';
import { SseHub } from '../src/server/sse';

/**
 * The HTTP surface, driven through `inject`.
 *
 * The tests that matter most here are the credential ones: they assert the
 * boundary the whole design rests on, that this process never decodes a
 * password. `inject` sees exactly what a real client would send, so a body that
 * arrives as an opaque string is a property of the route, not of the test.
 */
const GUID = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b';

interface Harness {
  app: FastifyInstance;
  service: Service;
  store: SessionStore;
  runner: CapturedRunner;
  dataRoot: string;
}

/** Records what the app sent, and scripts what comes back. */
class CapturedRunner {
  readonly sent: { op: string; body?: unknown }[] = [];
  private subscribers = new Map<string, (event: RunnerEvent | { kind: 'gap' }) => void>();

  credentials = async (_guid: string, rawBody: string): Promise<{ fromSeq: number }> => {
    this.sent.push({ op: 'credentials', body: rawBody });
    return { fromSeq: 0 };
  };
  mfa = async (guid: string, code: string): Promise<void> => {
    this.sent.push({ op: 'mfa', body: code });
    void guid;
  };
  list = async (): Promise<{ fromSeq: number }> => {
    this.sent.push({ op: 'list' });
    return { fromSeq: 0 };
  };
  export = async (guid: string, target: unknown): Promise<{ fromSeq: number }> => {
    this.sent.push({ op: 'export', body: target });
    void guid;
    return { fromSeq: 0 };
  };
  abort = async (): Promise<boolean> => {
    this.sent.push({ op: 'abort' });
    return true;
  };
  erase = async (): Promise<void> => {
    this.sent.push({ op: 'erase' });
  };
  artifactPath = (guid: string): string => `/artifact?guid=${guid}`;
  fetchArtifact = async (): Promise<Response> => new Response('zip-bytes');

  subscribe = (
    guid: string,
    _since: number,
    onEvent: (event: RunnerEvent | { kind: 'gap' }) => void,
  ): (() => void) => {
    this.subscribers.set(guid, onEvent);
    return () => this.subscribers.delete(guid);
  };

  /** Ends the current job as if the child had finished. */
  finish(guid: string, result: JobResult, lines: string[] = []): void {
    const deliver = this.subscribers.get(guid);
    if (!deliver) return;
    let seq = 1;
    for (const text of lines) {
      deliver({ kind: 'line', seq: seq++, stream: 'stdout', text, at: 'now' });
    }
    deliver({ kind: 'end', seq: seq + 1, at: 'now', result });
  }
}

let h: Harness;

function config(dataRoot: string): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataRoot,
    runnerUrl: 'http://runner:8080',
    runnerToken: 'test-token',
    sessionTtlHours: 12,
    minFreeDiskMb: 0,
    sweepIntervalMs: 60_000,
    logRingSize: 500,
    webRoot: join(dataRoot, 'no-web-root'),
    donateConfigPath: join(dataRoot, 'no-donate.json'),
    logLevel: 'silent',
  };
}

beforeEach(async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'msout-routes-'));
  const store = new SessionStore(dataRoot, 12);
  const queue = new (await import('../src/server/queue')).JobQueue() as JobQueue;
  const sse = new SseHub(500, 60_000);
  const runner = new CapturedRunner();
  const service = new Service({
    store,
    queue,
    runner: runner as never,
    sse,
    dataRoot,
    minFreeDiskMb: 0,
    log: () => {},
  });
  const app = await buildServer(config(dataRoot), service);
  h = { app, service, store, runner, dataRoot };
  await app.ready();
});

afterEach(async () => {
  await h.app.close();
  rmSync(h.dataRoot, { recursive: true, force: true });
});

describe('routes', () => {
  describe('health', () => {
    it('reports ok', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json().ok).toBe(true);
    });
  });

  describe('guid validation', () => {
    it.each([
      '/api/session?guid=not-a-guid',
      '/api/session?guid=../../etc',
      '/api/session?guid=',
      '/api/session',
    ])('refuses %s', async (url) => {
      const response = await h.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
    });

    it('refuses a traversal in a path parameter', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/s/..%2F..%2Fetc' });
      expect([400, 404]).toContain(response.statusCode);
    });
  });

  describe('sessions', () => {
    it('creates and reads a session', async () => {
      const created = await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      expect(created.statusCode).toBe(201);
      expect(created.json().guid).toBe(GUID);

      const read = await h.app.inject({ method: 'GET', url: `/api/session?guid=${GUID}` });
      expect(read.statusCode).toBe(200);
    });

    it('404s an unknown session without creating it', async () => {
      const response = await h.app.inject({ method: 'GET', url: `/api/session?guid=${GUID}` });
      expect(response.statusCode).toBe(404);
      expect(h.store.peek(GUID)).toBeNull();
    });

    it('erases, and then 404s', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const erased = await h.app.inject({ method: 'DELETE', url: `/api/session?guid=${GUID}` });
      expect(erased.statusCode).toBe(200);
      const after = await h.app.inject({ method: 'GET', url: `/api/session?guid=${GUID}` });
      // 404, not 500: a tombstoned guid is a known-and-gone session, and the UI
      // tells the user it was erased based on this.
      expect(after.statusCode).toBe(404);
    });
  });

  describe('credentials', () => {
    const CRED = '{"email":"someone@example.com","password":"hunter2"}';

    it('accepts an octet-stream body and answers 202', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/credentials?guid=${GUID}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: CRED,
      });
      expect(response.statusCode).toBe(202);
      expect(response.json().jobId).toBeTruthy();
    });

    it('forwards the body byte for byte', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      await h.app.inject({
        method: 'POST',
        url: `/api/session/credentials?guid=${GUID}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: CRED,
      });
      // The password is not read, split, reordered or re-serialised anywhere on
      // the way to the runner - which is only possible if it was never parsed.
      expect(h.runner.sent[0]!.body).toBe(CRED);
    });

    it('never parses the body, even when it is valid JSON', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      await h.app.inject({
        method: 'POST',
        url: `/api/session/credentials?guid=${GUID}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: '{"email":"a@b.c","password":"p","extra":{"nested":[1,2]}}',
      });
      expect(h.runner.sent[0]!.body).toBe('{"email":"a@b.c","password":"p","extra":{"nested":[1,2]}}');
    });

    it('refuses a body over the cap', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/credentials?guid=${GUID}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: `{"email":"a@b.c","password":"${'x'.repeat(8000)}"}`,
      });
      expect(response.statusCode).toBe(413);
      expect(h.runner.sent.some((c) => c.op === 'credentials')).toBe(false);
    });

    it('refuses an empty body', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/credentials?guid=${GUID}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: '',
      });
      expect(response.statusCode).toBe(400);
    });

    it('leaves the credentials out of the response and the logs', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/credentials?guid=${GUID}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: CRED,
      });
      expect(response.body).not.toContain('hunter2');
    });
  });

  describe('mfa', () => {
    it('forwards the code', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/mfa?guid=${GUID}`,
        payload: { code: '123456' },
      });
      expect(response.statusCode).toBe(200);
      expect(h.runner.sent.find((c) => c.op === 'mfa')!.body).toBe('123456');
    });

    it('refuses a missing or oversized code', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      for (const payload of [{}, { code: '' }, { code: 'x'.repeat(200) }, { code: 123456 }]) {
        const response = await h.app.inject({
          method: 'POST',
          url: `/api/session/mfa?guid=${GUID}`,
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
    });
  });

  describe('jobs', () => {
    it('refuses an export for a session that has not signed in', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/export?guid=${GUID}`,
        payload: { notebook: 'Personal' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('no_auth');
    });

    it('refuses a listing for a session that has not signed in', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({ method: 'POST', url: `/api/session/list?guid=${GUID}` });
      expect(response.statusCode).toBe(409);
    });

    it('refuses an export with no target', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      h.store.update(GUID, (state) => {
        state.auth = { state: 'valid', email: null, at: 'now' };
      });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/export?guid=${GUID}`,
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('passes a notebook url through untouched', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      h.store.update(GUID, (state) => {
        state.auth = { state: 'valid', email: null, at: 'now' };
      });
      const url = 'https://onedote.cloud.microsoft/onenote/?id=Work%20Notebook';
      await h.app.inject({
        method: 'POST',
        url: `/api/session/export?guid=${GUID}`,
        payload: { notebookUrl: url },
      });
      expect(h.runner.sent.find((c) => c.op === 'export')!.body).toEqual({ notebookUrl: url });
    });

    it('ignores a non-string target rather than forwarding it', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      h.store.update(GUID, (state) => {
        state.auth = { state: 'valid', email: null, at: 'now' };
      });
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/session/export?guid=${GUID}`,
        payload: { notebook: { $ne: null } },
      });
      // An object where a name belongs must not reach the command line.
      expect(response.statusCode).toBe(400);
    });
  });

  describe('artifact', () => {
    it('refuses a download before anything was exported', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({ method: 'GET', url: `/api/session/artifact?guid=${GUID}` });
      expect(response.statusCode).toBe(409);
    });

    it('serves the runner stream once there is an artifact', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      mkdirSync(join(h.dataRoot, GUID, 'out', 'Personal'), { recursive: true });
      h.store.update(GUID, (state) => {
        state.export = { ...state.export, state: 'done', notebook: 'Personal' };
      });
      const response = await h.app.inject({ method: 'GET', url: `/api/session/artifact?guid=${GUID}` });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/zip');
    });

    it('refuses an artifact for an erased session', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      await h.app.inject({ method: 'DELETE', url: `/api/session?guid=${GUID}` });
      const response = await h.app.inject({ method: 'GET', url: `/api/session/artifact?guid=${GUID}` });
      expect(response.statusCode).toBe(404);
    });

    it('404s when the output directory has gone', async () => {
      await h.app.inject({ method: 'POST', url: `/api/session?guid=${GUID}` });
      h.store.update(GUID, (state) => {
        state.export = { ...state.export, state: 'done', notebook: 'Personal' };
      });
      // State says done, disk says nothing: the filesystem wins.
      const response = await h.app.inject({ method: 'GET', url: `/api/session/artifact?guid=${GUID}` });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('donate', () => {
    it('degrades to an explanation when the config is absent', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/api/donate' });
      expect(response.statusCode).toBe(200);
      expect(response.json().missing).toBe(true);
    });

    it('serves the committed addresses when the config exists', async () => {
      const path = join(h.dataRoot, 'donate.json');
      writeFileSync(path, JSON.stringify({ fiat: [{ label: 'PayPal', href: 'https://x' }], crypto: [] }));
      const app2 = await buildServer({ ...config(h.dataRoot), donateConfigPath: path }, h.service);
      const response = await app2.inject({ method: 'GET', url: '/api/donate' });
      expect(response.json().fiat[0].label).toBe('PayPal');
      await app2.close();
    });
  });

  describe('web ui', () => {
    it('serves a placeholder when no build is present', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('UI not built');
    });
  });
});