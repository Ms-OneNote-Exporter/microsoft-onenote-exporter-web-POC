import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/server/config';
import { JobQueue } from '../src/server/queue';
import { buildServer } from '../src/server/routes';
import { Service } from '../src/server/service';
import { SessionStore } from '../src/server/session-store';
import { SseHub } from '../src/server/sse';

/**
 * Security headers.
 *
 * These are the promise PLAN-v3 §9.4 makes to anyone who types their Microsoft
 * password into this page, so they are asserted rather than assumed.
 */
let app: FastifyInstance;
let dataRoot: string;

const stubRunner = {
  credentials: async () => ({ fromSeq: 0 }),
  mfa: async () => {},
  list: async () => ({ fromSeq: 0 }),
  export: async () => ({ fromSeq: 0 }),
  abort: async () => true,
  erase: async () => {},
  artifactPath: () => '/artifact',
  fetchArtifact: async () => new Response('x'),
  subscribe: () => () => {},
};

beforeEach(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), 'msout-headers-'));
  const config: AppConfig = {
    port: 0,
    host: '127.0.0.1',
    dataRoot,
    runnerUrl: 'http://runner:8080',
    runnerToken: 't',
    sessionTtlHours: 12,
    minFreeDiskMb: 0,
    sweepIntervalMs: 60_000,
    logRingSize: 500,
    webRoot: join(dataRoot, 'none'),
    donateConfigPath: join(dataRoot, 'none.json'),
    logLevel: 'silent',
  };
  const service = new Service({
    store: new SessionStore(dataRoot, 12),
    queue: new JobQueue(),
    runner: stubRunner as never,
    sse: new SseHub(500, 60_000),
    dataRoot,
    minFreeDiskMb: 0,
    log: () => {},
  });
  app = await buildServer(config, service);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('security headers', () => {
  const response = () => app.inject({ method: 'GET', url: '/healthz' });

  it('sends a content security policy that allows only this origin', async () => {
    const csp = (await response()).headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('sets frame-ancestors in the header, where it has effect', async () => {
    // A meta CSP cannot set this; a browser ignores it there and warns.
    const csp = (await response()).headers['content-security-policy'];
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('allows no third-party origin anywhere', async () => {
    const csp = (await response()).headers['content-security-policy'];
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('sends nosniff', async () => {
    expect((await response()).headers['x-content-type-options']).toBe('nosniff');
  });

  it('sends no-referrer, so the GUID never leaks in a Referer header', async () => {
    expect((await response()).headers['referrer-policy']).toBe('no-referrer');
  });

  it('isolates the window from cross-origin references', async () => {
    const headers = (await response()).headers;
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('forbids caching a session page', async () => {
    expect((await response()).headers['cache-control']).toBe('no-store');
  });

  it('does not send HSTS over plain HTTP', async () => {
    // The POC has no TLS. Advertising HSTS here would make a browser refuse to
    // fall back to http for this host long after the service is stopped.
    expect((await response()).headers['strict-transport-security']).toBeUndefined();
  });

  it('applies to API responses too, not just pages', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/session?guid=3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b' });
    expect(api.headers['content-security-policy']).toContain("default-src 'self'");
    expect(api.headers['x-content-type-options']).toBe('nosniff');
  });
});