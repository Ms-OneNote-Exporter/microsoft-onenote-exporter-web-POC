import { join } from 'node:path';

/**
 * Runtime configuration, read once at boot.
 *
 * Everything the sidecar needs is read from the environment here, so a test can
 * construct a config object directly and a bad `docker compose` env fails at
 * startup rather than at the first login.
 */
export interface RunnerConfig {
  port: number;
  /** Shared with the app as `x-runner-token`. Required: an empty token is not a token. */
  token: string;
  dataRoot: string;
  loginTimeoutMs: number;
  exportTimeoutMs: number;
  listTimeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL on abort. */
  abortGraceMs: number;
  /** 500 lines per session: enough for a full MFA challenge, cheap in memory. */
  ringSize: number;
  /**
   * When true, spawn the fake CLIs in `src/fake` instead of the @msout packages.
   * For local development and for exercising this sidecar without a Microsoft
   * account. Never set in anything but dev - see .env.example.
   */
  fake: boolean;
  /**
   * Disables Chromium's renderer sandbox. Only for a host that cannot enable
   * unprivileged user namespaces, and it removes the reason a browser runs in
   * this container at all. See PLAN-v3(POC).md §18.
   */
  chromiumNoSandbox: boolean;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const token = (env.RUNNER_TOKEN ?? '').trim();
  if (!token) {
    // Failing here is deliberate. An empty token would be a shared secret that
    // everyone knows, and this process is the one that receives passwords.
    throw new Error('RUNNER_TOKEN is required (see .env.example)');
  }

  return {
    port: int('RUNNER_PORT', 8080),
    token,
    dataRoot: env.DATA_ROOT?.trim() || '/data',
    loginTimeoutMs: int('LOGIN_TIMEOUT_MS', 15 * 60_000),
    exportTimeoutMs: int('EXPORT_TIMEOUT_MS', 90 * 60_000),
    listTimeoutMs: int('LIST_TIMEOUT_MS', 5 * 60_000),
    abortGraceMs: int('ABORT_GRACE_MS', 10_000),
    ringSize: int('LOG_RING_SIZE', 500),
    fake: bool('MSOUT_FAKE'),
    chromiumNoSandbox: bool('CHROMIUM_NO_SANDBOX'),
  };
}

/** Absolute path to the compiled package root (`dist/`), where node_modules sits above it. */
export const PACKAGE_ROOT = join(__dirname, '..');

/**
 * Resolves a CLI entry point inside an installed @msout package.
 *
 * `main` in each package points at the CLI module, so the package's own metadata
 * decides where the entry point is. That is what makes the exact pinned version
 * the single source of truth: a new version that moves the file moves with it,
 * and a version whose entry point has gone missing fails loudly at spawn time
 * instead of silently exporting nothing.
 */
export function cliEntry(pkg: string): string {
  return require(`${pkg}/package.json`).main as string;
}