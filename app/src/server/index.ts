import { JobQueue } from './queue';
import { RunnerClient } from './runner-client';
import { buildServer } from './routes';
import { Service } from './service';
import { SessionStore } from './session-store';
import { SseHub } from './sse';
import { Sweeper } from './sweeper';
import { type AppConfig, assertDataUsable, loadConfig } from './config';

/**
 * Composition root.
 *
 * Everything is constructed here and injected, so a test can build the same
 * object graph with a fake runner and a temporary data root - no sockets, no
 * browser, no Microsoft account.
 */
export function buildService(config: AppConfig): {
  service: Service;
  store: SessionStore;
  queue: JobQueue;
  sse: SseHub;
} {
  const store = new SessionStore(config.dataRoot, config.sessionTtlHours);
  const queue = new JobQueue();
  const sse = new SseHub(config.logRingSize);
  const runner = new RunnerClient({ baseUrl: config.runnerUrl, token: config.runnerToken });

  const service = new Service({
    store,
    queue,
    runner,
    sse,
    dataRoot: config.dataRoot,
    minFreeDiskMb: config.minFreeDiskMb,
    log: () => {},
  });

  return { service, store, queue, sse };
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Before anything can serve a request. See assertDataUsable for what happens
  // when a dangling bind mount is discovered later instead.
  assertDataUsable(config.dataRoot);
  const { service, store, queue } = buildService(config);

  const server = await buildServer(config, service);

  // The sweeper erases through the service, not the store, so a session that
  // expires while a job is running also has its runner subscription closed and
  // its queue slot released. Going straight to the store would leak both.
  const sweeper = new Sweeper(store, config.sweepIntervalMs, (guid) => {
    void service.expireSession(guid);
  });
  sweeper.start();

  // Sweep when the queue changes as well as on the timer: a session blocked
  // behind a long export can cross its expiry while waiting, and the moment it
  // would start running is exactly the wrong moment to discover that.
  queue.onChange(() => {
    sweeper.sweep();
  });

  await server.listen({ port: config.port, host: config.host });
  server.log.info(
    { dataRoot: config.dataRoot, runner: config.runnerUrl },
    'app listening - the runner holds credentials; this process only proxies their bytes',
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.log.info(`${signal} received, shutting down`);
      sweeper.stop();
      void server.close().then(() => process.exit(0));
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}