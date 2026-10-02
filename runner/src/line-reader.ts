/**
 * Turns a child process's byte stream into whole lines.
 *
 * Child output is the only transport the POC has for everything the packages
 * would otherwise report through events, so getting this boundary right matters:
 * a line split across two chunks must not become two log lines, and the ANSI
 * codes that `chalk` emits must not survive into what the app parses.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Removes SGR colour sequences. Also strips a trailing CR from CRLF output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Accumulates chunks and hands back only the complete lines inside them.
 *
 * The trailing partial line is kept until the rest of it arrives, which is the
 * normal case for a prompt like `Enter the verification code: ` - readline
 * writes that without a newline and then blocks on stdin, so the bytes are
 * available but the line is not terminated.
 */
export class LineReader {
  private pending = '';
  /** How much of `pending` has already been handed out as a tail. */
  private published = 0;

  /** @returns the complete lines contained in `chunk`, with the remainder held back. */
  push(chunk: string): string[] {
    // Strip on the *concatenated* buffer, never on the chunk alone. An escape
    // sequence can straddle a chunk boundary - '\u001b[3' then '4m[INFO]' - and
    // stripping each piece separately leaves the residue '[34m' in the middle of
    // the line, which is exactly the kind of corruption that turns into a
    // silently mis-parsed log line much further downstream.
    const combined = stripAnsi(this.pending + chunk);
    const parts = combined.split('\n');
    // The last element is either '' (clean newline) or an incomplete line.
    this.pending = parts.pop() ?? '';
    if (parts.length > 0) {
      // A newline completed one or more lines, so whatever is now pending is the
      // start of a *new* line and nothing of it has been published yet.
      //
      // Resetting unconditionally would be wrong: a prompt arriving in several
      // chunks ('Enter the code' then ': ') completes no line, and clearing the
      // counter there would re-publish the whole prompt on the next tail read -
      // so the user would see their MFA prompt twice.
      this.published = 0;
    }
    return parts.map((line) => line.replace(/\r$/, ''));
  }

  /**
   * The part of the unterminated tail that has not been handed out yet.
   *
   * This exists for one reason: `microsoft-webauth` prompts for an MFA code with
   * `rl.question()`, which writes the prompt and blocks on stdin **without a
   * trailing newline**. A reader that only emits newline-terminated lines would
   * never surface the prompt, and the MFA challenge - the whole reason the
   * browser has a code input - would silently never appear.
   *
   * When the newline finally arrives, the same text is emitted once more as a
   * complete line. The app treats the challenge signal as idempotent and the log
   * panel drops consecutive duplicate lines, so the user sees one prompt.
   */
  takeUnpublishedTail(): string | null {
    if (this.pending.length <= this.published) return null;
    const tail = this.pending.slice(this.published);
    this.published = this.pending.length;
    return tail === '' ? null : tail;
  }

  /**
   * Whatever is buffered without a trailing newline. Called once at stream end,
   * so a last line written without a newline is not lost.
   */
  flush(): string {
    const rest = this.pending.replace(/\r$/, '');
    this.pending = '';
    this.published = 0;
    return rest;
  }

  /** The incomplete tail, as it stands. */
  tail(): string {
    return this.pending;
  }
}