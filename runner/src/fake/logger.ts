/**
 * The logger the fake CLIs use.
 *
 * Reproduces the two *different* timestamp formats the real packages emit,
 * because they genuinely differ and a parser that only handles one will look
 * correct in fake mode and break against production:
 *
 *   microsoft-webauth, microsoft-onenote-list-notebooks
 *     [Oct 02 20:39:57] [INFO] message
 *   microsoft-onenote-export-notebook
 *     [2026-10-02 20:39:18+02:00] [INFO] message
 *
 * Both were captured from the published packages, not guessed.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type Stamp = 'monthName' | 'isoWithOffset';

function tzOffset(now: Date): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function timestamp(now: Date, stamp: Stamp): string {
  const day = String(now.getDate()).padStart(2, '0');
  const time = now.toTimeString().split(' ')[0];
  if (stamp === 'monthName') {
    return `[${MONTHS[now.getMonth()]} ${day} ${time}]`;
  }
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `[${now.getFullYear()}-${month}-${day} ${time}${tzOffset(now)}]`;
}

/**
 * A log call.
 *
 * `detail` mirrors the real loggers' `logger.error(message, error)` signature:
 * they print the message and then the error's stack on the following lines,
 * which is what an `Error:` line in captured output actually is.
 */
export function makeLogger(stamp: Stamp) {
  return function log(
    level: 'DEBUG' | 'INFO' | 'STEP' | 'WARN' | 'SUCCESS' | 'ERROR',
    message: string,
    detail?: unknown,
  ) {
    const prefix = `${timestamp(new Date(), stamp)} [${level}] ${message}`;
    const text =
      detail === undefined
        ? prefix
        : `${prefix}\n${detail instanceof Error ? String(detail.stack ?? detail) : String(detail)}`;
    // The real loggers write INFO/STEP/WARN/SUCCESS/DEBUG to stdout and ERROR to
    // stderr, and the app must not assume cross-stream ordering.
    if (level === 'ERROR') process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  };
}

/** Parses `--flag value` pairs the way the fakes need; the real CLIs use commander. */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[arg.slice(2)] = next;
      i += 1;
    } else {
      out[arg.slice(2)] = 'true';
    }
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));