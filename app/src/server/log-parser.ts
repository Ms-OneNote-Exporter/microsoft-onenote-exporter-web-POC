import type { AppErrorCode, LogLevel } from '@msout-poc/shared';

/**
 * Turns a line of @msout package output into something the app can act on.
 *
 * This module is the POC's substitute for the structured events PLAN-v2 §6 asked
 * the packages to emit. Every pattern below is taken from output captured by
 * running the published packages, and the fixtures in test/fixtures are that
 * captured output verbatim.
 *
 * The honest consequence: this is coupled to log wording. A package that
 * rewords a line loses a signal, silently. That is the cost of not being allowed
 * to change the packages, and it is why the raw line is always kept alongside
 * whatever was inferred from it.
 */

/** What a line means to the app. */
export type Signal =
  | { kind: 'none' }
  /** `Enter the verification code: ` - a code challenge. */
  | { kind: 'mfa-code' }
  /** Number-match: one number, approved on the user's device. */
  | { kind: 'mfa-number'; number: string }
  /** Login succeeded. Necessary but not sufficient: auth.json must exist too. */
  | { kind: 'login-success' }
  /** Login failed. Since 0.1.9 the CLI also exits 1 and says so. */
  | { kind: 'login-failed' }
  /**
   * 0.1.9 reached the signed-in app but the auth file is missing, unparseable
   * or not a Playwright storage state. New in 0.1.9, and the failure that used
   * to be reported as a success with nothing usable behind it.
   */
  | { kind: 'login-state-unusable'; reason: string }
  /** `microsoft-webauth check` confirmed the session is live. */
  | { kind: 'check-authenticated' }
  /** `check` did not confirm it, with the reason it gives. */
  | { kind: 'check-not-authenticated'; reason: string }
  /** One page was written to disk. Carries the asset count it saved with. */
  | { kind: 'page-exported'; assets: number }
  /** `Pages    failed: 2` - the exporter's own tally of pages it could not write. */
  | { kind: 'pages-failed'; pages: number }
  /**
   * `Files saved in: <absolute path>` - where the exporter actually wrote.
   *
   * Preferred over deriving the directory from the notebook name, because the
   * name is user text and gets sanitised on the way to a filename. Callers must
   * resolve this against the session's own output directory and discard it if it
   * lands anywhere else; see `relativeInside`.
   */
  | { kind: 'files-saved-in'; dir: string }
  /** Final page count. */
  | { kind: 'total-pages'; pages: number }
  /** Final asset count. */
  | { kind: 'total-assets'; assets: number }
  /** The export produced a clean result. */
  | { kind: 'export-complete' }
  /** The export finished with per-item failures. */
  | { kind: 'export-partial' }
  /**
   * 0.4.0's line for a run that found no section list at all.
   *
   * The package says plainly that this is what an expired or refused sign-in
   * looks like, and that nothing was written. Before 0.4.0 the same situation
   * printed `Export complete!` with `Total Pages: 0` and exited 0 - a green
   * successful export containing nothing, which this app believed and displayed.
   *
   * Keyed on the ERROR line rather than the warnings under it, because that is
   * the one the package emits unconditionally in this case and the warnings are
   * prose that could be reworded.
   */
  | { kind: 'export-no-sections' }
  /** The export stopped early. */
  | { kind: 'export-stopped' }
  /** The OneNote tab died mid-run. */
  | { kind: 'export-crashed' }
  /** The requested notebook was not in the list. */
  | { kind: 'notebook-not-found'; available: string[] }
  /** `--non-interactive` was used with no target: a POC bug, not a user error. */
  | { kind: 'no-target' }
  /** auth.json is missing, so no job can start. */
  | { kind: 'no-auth' }
  /** Microsoft is challenging this server address. */
  | { kind: 'captcha-required' }
  | { kind: 'microsoft-blocked' }
  /** The notebook list from `list-notebooks`. */
  | { kind: 'notebooks'; items: { name: string; url: string | null }[] }
  | { kind: 'done' };

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * The logger prefix, in both shapes the packages use.
 *
 * `microsoft-webauth` and `microsoft-onenote-list-notebooks`:
 *   [Oct 02 20:39:57] [INFO] message
 * `microsoft-onenote-export-notebook`:
 *   [2026-10-02 20:39:18+02:00] [INFO] message
 *
 * Both were captured from the published packages. The two formats are the reason
 * this regex lists both instead of assuming one: a parser written against only
 * the first looks perfectly correct in fake mode and then treats every export
 * line as unprefixed text.
 */
const PREFIX_RE =
  /^(?:\[[A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2}\]|\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?\])\s*\[(DEBUG|INFO|STEP|WARN|SUCCESS|ERROR)\]\s*(.*)$/s;

/** A parsed line: the prefix, or the whole thing as unprefixed text. */
export interface ParsedLine {
  level: LogLevel;
  text: string;
  raw: string;
  prefixed: boolean;
}

/** Removes ANSI colour codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Splits a logger prefix off a line, in either of the two formats. */
export function parseLine(raw: string): ParsedLine {
  const clean = stripAnsi(raw).replace(/\r$/, '');
  const match = PREFIX_RE.exec(clean);
  if (!match) {
    // Continuation of a multi-line message, or something we do not recognise.
    // Kept as info so it is still displayed rather than silently dropped.
    return { level: 'info', text: clean, raw, prefixed: false };
  }
  // match[1] is the level, match[2] the message. Both timestamp alternatives are
  // non-capturing, so the indices do not shift when a format is added.
  const level = match[1]!.toLowerCase() as LogLevel;
  return { level, text: match[2]!, raw, prefixed: true };
}

/** `Files saved in: /data/<guid>/out/The Complete Notebook` */
const FILES_SAVED_RE = /^Files saved in:\s*(.+?)\s*$/;
/** `  Pages    failed: 2` - the per-category failure tally. */
const PAGES_FAILED_RE = /^Pages\s+failed:\s*(\d+)\s*$/;
/** `Nothing was exported: the section list for this notebook was never found.` */
const NO_SECTIONS_RE = /^Nothing was exported: the section list for this notebook was never found\.$/;
/** `1. Personal (https://…)` - the only machine-ish output the lister has. */
const NOTEBOOK_RE = /^\s*(\d+)\.\s+(.+?)\s+\((https?:\/\/[^)]+)\)\s*$/;

/**
 * `Saved (2 assets)` - the line that means a page reached disk.
 *
 * This is deliberately NOT `Exporting: <page> ...`, which is what this parser
 * used to count. `Exporting:` is printed when a page export *starts*, so a page
 * that fails and is retried is counted twice, and a page that fails outright is
 * counted once despite writing nothing.
 *
 * Measured on a real 24-page export: 26 `Exporting:` lines, 24 `Saved` lines,
 * 2 `Failed to export`, and 24 `.md` files on disk. Only `Saved` agrees with
 * the filesystem.
 */
const SAVED_RE = /^Saved \((\d+) assets?\)$/;
const TOTAL_PAGES_RE = /^Total Pages:\s*(\d+)\s*$/;
const TOTAL_ASSETS_RE = /^Total Assets:\s*(\d+)/;
const MFA_NUMBER_RE = /^\s*Enter the number:\s*(\d+)\s*$/;
const TOTAL_SECTIONS_RE = /^\s*Sections failed:\s*(\d+)\s*$/;

/**
 * Classifies a line.
 *
 * Order matters. `Total Assets: 12 (3 could not be downloaded)` has to be
 * classified as a total before the "export finished with errors" line that
 * precedes it can be, and `Exporting notebook: X` must not match the
 * per-page `Exporting:` pattern.
 */
export function classify(text: string): Signal {
  // Strip a leading logger level word some packages include inside messages.
  const line = text.trim();

  // --- MFA -------------------------------------------------------------
  // The prompt readline writes has no trailing newline and no level tag; it is
  // matched on its distinctive wording.
  if (/Enter the verification code:\s*$/i.test(line) || /^Enter the verification code:/i.test(line)) {
    return { kind: 'mfa-code' };
  }
  const mfaNumber = MFA_NUMBER_RE.exec(line);
  if (mfaNumber) return { kind: 'mfa-number', number: mfaNumber[1]! };

  // --- login -----------------------------------------------------------
  if (/^Authentication successful!/i.test(line)) return { kind: 'login-success' };
  if (/^Authentication failed or cancelled/i.test(line)) return { kind: 'login-failed' };

  // New in 0.1.9. Checked before the generic failure line because it is the more
  // specific explanation and both appear on the same run.
  const unusable = /^Login reached the authenticated interface but the auth file is not usable \(([^)]+)\)/i.exec(line);
  if (unusable) return { kind: 'login-state-unusable', reason: unusable[1]!.toLowerCase() };

  // --- check -----------------------------------------------------------
  // `check` became trustworthy at 0.1.9, which is what made the preflight
  // possible; these are the two lines that carry its verdict.
  if (/^Authentication file found\. You are authenticated\./i.test(line)) {
    return { kind: 'check-authenticated' };
  }
  const notAuthed = /^Not authenticated \(([^)]+)\)\./i.exec(line);
  if (notAuthed) return { kind: 'check-not-authenticated', reason: notAuthed[1]!.toLowerCase() };

  // --- blocking / abuse ------------------------------------------------
  if (/captcha|verify (that )?you'?re (a )?human|unusual activity/i.test(line)) {
    return { kind: 'captcha-required' };
  }
  if (/blocked (your|the) (sign-?in|request|activity)|from your (ip|network|address)/i.test(line)) {
    return { kind: 'microsoft-blocked' };
  }

  // --- target resolution ----------------------------------------------
  if (/^--non-interactive requires either --notebook/i.test(line)) return { kind: 'no-target' };
  // `Error: ` prefix tolerated: the packages log the thrown Error's stack, whose
  // first line is "Error: <message>".
  //
  // The *last* pair of quotes wins for the requested name: a notebook name may
  // itself contain a quote (`Recipes & "stuff"`), so anchoring on the first pair
  // would capture the wrong text whenever the unavailable notebook's name
  // contains one. The available list is captured lazily for the same reason - it
  // can contain quoted names too.
  const notFound =
    /^(?:Error:\s*)?Notebook ".*" not found in list\.\s*Available:\s*(.*)$/i.exec(line);
  if (notFound) {
    return { kind: 'notebook-not-found', available: (notFound[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
  }
  // The packages emit this as a bare `Error: …` continuation line, so the
// optional `Error: ` prefix has to be tolerated. Anchored at the start of the
// line rather than matched anywhere: "auth.json is missing" in prose is not
// this signal.
  if (/^(?:Error:\s*)?Authentication file not found:/i.test(line)) return { kind: 'no-auth' };

  // --- export outcome --------------------------------------------------
  if (NO_SECTIONS_RE.test(line)) return { kind: 'export-no-sections' };
  if (/^Export complete!/i.test(line)) return { kind: 'export-complete' };
  if (/^Export (finished with errors|stopped early)/i.test(line)) return { kind: 'export-partial' };
  if (/^Unexpected internal failure during the export/i.test(line)) return { kind: 'export-crashed' };

  // --- counts ----------------------------------------------------------
  const totalPages = TOTAL_PAGES_RE.exec(line);
  if (totalPages) return { kind: 'total-pages', pages: Number.parseInt(totalPages[1]!, 10) };
  const totalAssets = TOTAL_ASSETS_RE.exec(line);
  if (totalAssets) return { kind: 'total-assets', assets: Number.parseInt(totalAssets[1]!, 10) };

  // --- where the output landed -----------------------------------------
  // Checked before `Saved`, which is a substring-free match, and reported as a
  // path for the caller to validate rather than trusted: it is text this
  // service did not write, so it is data, not an instruction.
  const filesSaved = FILES_SAVED_RE.exec(line);
  if (filesSaved) return { kind: 'files-saved-in', dir: filesSaved[1]! };

  // --- counts ----------------------------------------------------------
  const pagesFailed = PAGES_FAILED_RE.exec(line);
  if (pagesFailed) return { kind: 'pages-failed', pages: Number.parseInt(pagesFailed[1]!, 10) };

  // --- progress --------------------------------------------------------
  // After the counts, so `Exporting notebook: X` and `Exporting: <page> ...`
  // cannot be mistaken for either.
  const saved = SAVED_RE.exec(line);
  if (saved) return { kind: 'page-exported', assets: Number.parseInt(saved[1]!, 10) };

  // --- notebook list ---------------------------------------------------
  const nb = NOTEBOOK_RE.exec(line);
  if (nb) {
    return {
      kind: 'notebooks',
      items: [{ name: nb[2]!.trim(), url: nb[3]!.trim() }],
    };
  }

  return { kind: 'none' };
}

/**
 * Collects notebook rows into a list, in order.
 *
 * Separate from `classify` because the list is the one signal that arrives as
 * many lines and needs assembling.
 */
export class NotebookCollector {
  private items: { name: string; url: string | null }[] = [];

  /** @returns true when the line was part of a notebook listing. */
  push(text: string): boolean {
    const line = stripAnsi(text);
    // `Available Notebooks:` header - resets, so a re-list never doubles up.
    if (/^Available Notebooks:\s*$/i.test(line.trim())) {
      this.items = [];
      return true;
    }
    const match = NOTEBOOK_RE.exec(line);
    if (!match) return false;
    const name = match[2]!.trim();
    const url = match[3]!.trim();
    // De-duplicate: the same name can appear twice if a log line is replayed.
    if (!this.items.some((item) => item.name === name && item.url === url)) {
      this.items.push({ name, url });
    }
    return true;
  }

  list(): { name: string; url: string | null }[] {
    return [...this.items];
  }

  get count(): number {
    return this.items.length;
  }

  reset(): void {
    this.items = [];
  }
}

/**
 * Picks an error code from whatever the job produced.
 *
 * Used when the process ended without a conclusive signal. Signal-derived codes
 * win; this is the fallback, and `unknown` is a legitimate answer here rather
 * than a failure to look harder.
 *
 * `kind` matters to the fallback. A non-zero exit used to map to
 * `export_failed`, which was wrong for a login: before 0.1.9 a login could not
 * exit non-zero at all, so any code arriving here was an export - and now that
 * it can, the kind is the only thing that separates the two.
 */
export function errorFromLines(
  lines: string[],
  exitCode: number | null,
  kind: 'login' | 'check' | 'list' | 'export' = 'export',
): AppErrorCode {
  const joined = lines.join('\n');

  // 0.1.9: the app was reached and the auth file is not usable. More specific
  // than "the login failed", and the one the user can act on.
  if (/the auth file is not usable \((?:missing|unreadable|malformed)\)/i.test(joined)) {
    return 'no_auth';
  }
  if (/Not authenticated \(expired\)/i.test(joined)) return 'auth_expired';
  if (/Not authenticated \(stayed_unauthenticated\)/i.test(joined)) return 'auth_expired';
  if (/Not authenticated \(unverifiable\)/i.test(joined)) return 'auth_unverified';
  if (/Not authenticated \((?:no_auth_file|unusable_auth_file)\)/i.test(joined)) return 'no_auth';

  if (/Authentication file not found:/i.test(joined)) return 'no_auth';
  if (/--non-interactive requires either/i.test(joined)) return 'no_target';
  if (/not found in list/i.test(joined)) return 'notebook_not_found';
  if (/captcha|verify (that )?you'?re (a )?human/i.test(joined)) return 'captcha_required';
  if (/blocked (your|the) (sign-?in|request|activity)/i.test(joined)) return 'microsoft_blocked';
  if (/Authentication failed or cancelled/i.test(joined)) return 'bad_credentials';
  if (/Unexpected internal failure during the export/i.test(joined)) return 'crashed';
  if (/Export (finished with errors|stopped early)/i.test(joined)) return 'export_partial';

  // Nothing conclusive in the log, so only the exit code is left. It still is
  // not a diagnosis - only a failure.
  if (kind === 'login') return 'bad_credentials';
  if (kind === 'check') return 'auth_unverified';
  if (exitCode === 2) return 'no_target';
  if (exitCode !== null && exitCode !== 0) return 'export_failed';
  return 'unknown';
}