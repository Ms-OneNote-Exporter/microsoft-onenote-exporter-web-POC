import { dirname, join } from 'node:path';

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
  /** A preflight check launches a browser and loads OneNote, so it gets its own budget. */
  checkTimeoutMs: number;
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

/**
 * Both read the `env` argument rather than `process.env`.
 *
 * That is not a stylistic preference: taking the parameter and then ignoring it
 * means `loadConfig(someEnv)` returns a configuration built from a different
 * source, which is a bug that only shows up when someone tries to configure the
 * process without mutating its environment.
 */
function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = env[name];
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
    port: int(env, 'RUNNER_PORT', 8080),
    token,
    dataRoot: env.DATA_ROOT?.trim() || '/data',
    loginTimeoutMs: int(env, 'LOGIN_TIMEOUT_MS', 15 * 60_000),
    exportTimeoutMs: int(env, 'EXPORT_TIMEOUT_MS', 90 * 60_000),
    listTimeoutMs: int(env, 'LIST_TIMEOUT_MS', 5 * 60_000),
    checkTimeoutMs: int(env, 'CHECK_TIMEOUT_MS', 2 * 60_000),
    abortGraceMs: int(env, 'ABORT_GRACE_MS', 10_000),
    ringSize: int(env, 'LOG_RING_SIZE', 500),
    fake: bool(env, 'MSOUT_FAKE'),
    chromiumNoSandbox: bool(env, 'CHROMIUM_NO_SANDBOX'),
  };
}

/** Absolute path to the compiled package root (`dist/`), where node_modules sits above it. */
export const PACKAGE_ROOT = join(__dirname, '..');

/**
 * Resolves the CLI entry point of an installed @msout package.
 *
 * Through the `./cli` subpath, which each of the three packages declares in its
 * `exports` map. That is deliberate on their part - it is the supported way to
 * reach the command-line entry point - and it is also the only one that works,
 * because their `exports` maps do not open `./src/index.js` to consumers.
 *
 * Two mistakes are encoded as comments here because both were made, and both are
 * invisible in fake mode:
 *
 *   - `main` is the *library* (`src/auth.js`), not the program. Running it starts
 *     a file that defines some functions and exits. The first live login died in
 *     fifty milliseconds with no output, while every fake-mode test passed,
 *     because fake mode names its own script and never resolves this.
 *   - Resolving `<pkg>/<bin>` fails outright, because `exports` hides the file.
 *
 * The package's own metadata remains the single source of truth for where the
 * entry point lives, so a version that moves it moves with it.
 */
export function cliEntry(pkg: string): string {
  try {
    return require.resolve(`${pkg}/cli`);
  } catch {
    // A version without the subpath: fall back to the declared bin, resolved
    // against the package directory rather than through `exports`.
  }

  const meta = require(`${pkg}/package.json`) as { bin?: string | Record<string, string> };
  const bin = typeof meta.bin === 'string' ? meta.bin : Object.values(meta.bin ?? {})[0];
  if (!bin) {
    throw new Error(`${pkg} exposes no ./cli subpath and declares no bin; cannot run it as a CLI`);
  }
  const root = dirname(require.resolve(`${pkg}/package.json`)).replace(/[/\\]package\.json$/, '');
  return join(root, bin);
}
