import { join } from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  /** Where session directories live. Must be the same path the runner sees. */
  dataRoot: string;
  runnerUrl: string;
  runnerToken: string;
  sessionTtlHours: number;
  minFreeDiskMb: number;
  /** How often the sweeper looks for expired sessions. */
  sweepIntervalMs: number;
  /** How many log lines are kept per session for replay. */
  logRingSize: number;
  /** Directory of the built React app, when it exists. */
  webRoot: string;
  /** Donation targets, committed to the repo so they are auditable. See DONATE.md. */
  donateConfigPath: string;
  logLevel: string;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const runnerToken = (env.RUNNER_TOKEN ?? '').trim();
  if (!runnerToken) {
    // Without it the app cannot talk to the runner at all. Failing loudly beats
    // starting a service that looks healthy and 401s on every request.
    throw new Error('RUNNER_TOKEN is required (see .env.example)');
  }

  const distDir = join(__dirname, '..');
  return {
    port: int('PORT', 3000),
    // 0.0.0.0 so the POC is reachable from the LAN as well as localhost.
    host: (env.HOST ?? '0.0.0.0').trim(),
    dataRoot: env.DATA_ROOT?.trim() || '/data',
    runnerUrl: (env.RUNNER_URL?.trim() || 'http://runner:8080').replace(/\/+$/, ''),
    runnerToken,
    sessionTtlHours: int('SESSION_TTL_HOURS', 12),
    minFreeDiskMb: int('MIN_FREE_DISK_MB', 2048),
    sweepIntervalMs: int('SWEEP_INTERVAL_MS', 60_000),
    logRingSize: int('LOG_RING_SIZE', 500),
    webRoot: env.WEB_ROOT?.trim() || join(distDir, 'public'),
    donateConfigPath: env.DONATE_CONFIG?.trim() || join(distDir, '..', 'donate.config.json'),
    logLevel: (env.LOG_LEVEL ?? 'info').trim(),
  };
}