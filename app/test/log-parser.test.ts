import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NotebookCollector,
  classify,
  errorFromLines,
  parseLine,
  stripAnsi,
} from '../src/server/log-parser';

/**
 * These tests are the POC's contract with the published packages.
 *
 * Most fixtures are verbatim captures produced by running the packages; the two
 * hand-written ones say so in their first line. Everything asserted here was
 * observed, not assumed - the two timestamp formats and the exit-0-on-failure
 * behaviour in particular are properties that would be easy to get wrong by
 * reasoning alone.
 */
function fixture(name: string): string[] {
  const path = join(dirname(new URL(import.meta.url).pathname), 'fixtures', name);
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

describe('parseLine', () => {
  it('parses the webauth and list-notebooks timestamp format', () => {
    // Captured from microsoft-webauth@0.1.8, and still true at 0.1.9: the
    // month-name timestamp format did not change.
    const p = parseLine('[Oct 02 20:39:57] [INFO] Attempting automated login for a@b.c...');
    expect(p).toMatchObject({ level: 'info', text: 'Attempting automated login for a@b.c...', prefixed: true });
  });

  it('parses the export-notebook timestamp format, which is different', () => {
    // Captured from microsoft-onenote-export-notebook@0.3.7.
    const p = parseLine('[2026-10-02 20:39:18+02:00] [INFO] Connecting to OneNote...');
    expect(p).toMatchObject({ level: 'info', text: 'Connecting to OneNote...', prefixed: true });
  });

  it.each(['DEBUG', 'INFO', 'STEP', 'WARN', 'SUCCESS', 'ERROR'])('recognises the %s level', (level) => {
    const p = parseLine(`[Oct 02 20:39:57] [${level}] something happened`);
    expect(p.level).toBe(level.toLowerCase());
    expect(p.prefixed).toBe(true);
  });

  it('treats an unprefixed line as text, so a prompt is not lost', () => {
    // This is what readline writes for the MFA code prompt.
    const p = parseLine('Enter the verification code: ');
    expect(p.text).toBe('Enter the verification code: ');
    expect(p.prefixed).toBe(false);
  });

  it('keeps a continuation line of a multi-line error', () => {
    const p = parseLine('Error: Login Error (Password): Your account or password is incorrect.');
    expect(p.prefixed).toBe(false);
    expect(p.text).toContain('Login Error (Password)');
  });

  it('strips chalk colours', () => {
    expect(stripAnsi('\u001b[34m[INFO]\u001b[39m hi')).toBe('[INFO] hi');
    const p = parseLine('\u001b[90m[Oct 02 20:39:57]\u001b[39m \u001b[34m[INFO]\u001b[39m hello');
    expect(p.text).toBe('hello');
  });

  it('tolerates a carriage return', () => {
    expect(parseLine('[Oct 02 20:39:57] [INFO] hi\r').text).toBe('hi');
  });

  it('preserves the raw line so an unknown message stays diagnosable', () => {
    const raw = '[Oct 02 20:39:57] [INFO] something new';
    expect(parseLine(raw).raw).toBe(raw);
  });
});

describe('classify', () => {
  it('detects the MFA code prompt', () => {
    expect(classify('Enter the verification code: ')).toEqual({ kind: 'mfa-code' });
  });

  it('detects the MFA code prompt with a trailing newline already consumed', () => {
    expect(classify('Enter the verification code:')).toEqual({ kind: 'mfa-code' });
  });

  it('extracts the number-match number, preserving leading digits', () => {
    expect(classify('  Enter the number:  424242')).toEqual({ kind: 'mfa-number', number: '424242' });
    expect(classify('  Enter the number:  007')).toEqual({ kind: 'mfa-number', number: '007' });
  });

  it('never reads the number-match number as a page count or a total', () => {
    // A number on its own line is a challenge, not progress.
    expect(classify('424242').kind).toBe('none');
  });

  it('detects login success', () => {
    expect(classify('Authentication successful! State saved to /data/x/auth.json')).toEqual({
      kind: 'login-success',
    });
  });

  it('detects login failure', () => {
    expect(classify('Authentication failed or cancelled:')).toEqual({ kind: 'login-failed' });
  });

  describe('0.1.9 additions', () => {
    it('detects a login that reached the app but saved nothing usable', () => {
      expect(
        classify(
          'Login reached the authenticated interface but the auth file is not usable (malformed): /data/x/auth.json has no "cookies" array',
        ),
      ).toEqual({ kind: 'login-state-unusable', reason: 'malformed' });
    });

    it.each(['missing', 'unreadable', 'malformed'])('carries the reason %s through', (reason) => {
      expect(
        classify(`Login reached the authenticated interface but the auth file is not usable (${reason}): detail`),
      ).toEqual({ kind: 'login-state-unusable', reason });
    });

    it('detects a confirmed check', () => {
      expect(classify('Authentication file found. You are authenticated.')).toEqual({
        kind: 'check-authenticated',
      });
    });

    it.each([
      'expired',
      'stayed_unauthenticated',
      'unverifiable',
      'no_auth_file',
      'unusable_auth_file',
    ])('carries the check reason %s through', (reason) => {
      expect(classify(`Not authenticated (${reason}). some detail here`)).toEqual({
        kind: 'check-not-authenticated',
        reason,
      });
    });

    it('does not confuse the check verdict with a login success', () => {
      // "authenticated" appears in both worlds; only one of them is a login.
      expect(classify('Authentication file found. You are authenticated.').kind).toBe('check-authenticated');
      expect(classify('Authentication successful! State saved to /data/x').kind).toBe('login-success');
    });

    it('ignores the check summary line, which is not itself a verdict', () => {
      expect(
        classify('check failed (exit 1). No authenticated session could be confirmed.').kind,
      ).toBe('none');
    });
  });

  it('counts a finished page', () => {
    expect(classify('Exporting: Meeting notes ...')).toEqual({ kind: 'page-exported' });
  });

  it('does not mistake the notebook banner for a finished page', () => {
    // Real output: "Exporting notebook: Personal" has no trailing ellipsis.
    // Without the distinction, every export would report a phantom page.
    expect(classify('Exporting notebook: Personal').kind).toBe('none');
  });

  it('reads the final page total', () => {
    expect(classify('Total Pages: 41')).toEqual({ kind: 'total-pages', pages: 41 });
  });

  it('reads a page total of zero without treating it as absent', () => {
    expect(classify('Total Pages: 0')).toEqual({ kind: 'total-pages', pages: 0 });
  });

  it('reads the asset total alongside a failure count', () => {
    expect(classify('Total Assets: 12 (3 could not be downloaded)')).toEqual({
      kind: 'total-assets',
      assets: 12,
    });
  });

  it.each([
    ['Export complete!', 'export-complete'],
    ['Export finished with errors - 3 item(s) could not be exported.', 'export-partial'],
    ['Export stopped early - the OneNote editor tab went away.', 'export-partial'],
  ])('reads "%s" as %s', (line, expected) => {
    expect(classify(line).kind).toBe(expected);
  });

  it('detects a dead OneNote tab', () => {
    expect(
      classify('Unexpected internal failure during the export (this is a bug):'),
    ).toEqual({ kind: 'export-crashed' });
  });

  it('detects a notebook that is not in the list, and names the alternatives', () => {
    expect(
      classify('Notebook "Nope" not found in list. Available: Personal, Work, Recipes'),
    ).toEqual({ kind: 'notebook-not-found', available: ['Personal', 'Work', 'Recipes'] });
  });

  it('detects the fail-fast when --non-interactive has no target', () => {
    expect(
      classify('--non-interactive requires either --notebook <name> or --notebook-link <url>.'),
    ).toEqual({ kind: 'no-target' });
  });

  it('detects a missing auth file', () => {
    expect(classify('Error: Authentication file not found: /data/x/auth.json')).toEqual({
      kind: 'no-auth',
    });
  });

  it('detects a captcha challenge', () => {
    expect(classify('Please solve the captcha to continue').kind).toBe('captcha-required');
  });

  it('detects a datacenter IP block', () => {
    expect(classify('Microsoft has blocked your sign-in from this network').kind).toBe(
      'microsoft-blocked',
    );
  });

  it('reads one notebook row', () => {
    expect(classify('1. Personal (https://onedote.cloud.microsoft/onenote/?id=Personal)')).toEqual({
      kind: 'notebooks',
      items: [{ name: 'Personal', url: 'https://onedote.cloud.microsoft/onenote/?id=Personal' }],
    });
  });

  it('keeps quotes and ampersands in a notebook name', () => {
    const signal = classify('3. Recipes & "stuff" (https://example.invalid/nb/3)');
    expect(signal).toEqual({
      kind: 'notebooks',
      items: [{ name: 'Recipes & "stuff"', url: 'https://example.invalid/nb/3' }],
    });
  });

  it('is not fooled by an ordinary sentence', () => {
    expect(classify('Fetching notebooks...').kind).toBe('none');
    expect(classify('Connecting to OneNote...').kind).toBe('none');
    expect(classify('Files saved in: /data/x/out/Personal').kind).toBe('none');
  });

  it('returns none rather than guessing', () => {
    // The honest default. A signal invented from a line nobody has seen is worse
    // than no signal, because it becomes state the user cannot explain.
    expect(classify('A line nobody has ever seen before').kind).toBe('none');
  });
});

describe('NotebookCollector', () => {
  it('assembles a list from the captured listing lines', () => {
    const collector = new NotebookCollector();
    collector.push('Available Notebooks:');
    collector.push('1. Personal (https://example.invalid/1)');
    collector.push('2. Work (https://example.invalid/2)');
    expect(collector.count).toBe(2);
    expect(collector.list()).toEqual([
      { name: 'Personal', url: 'https://example.invalid/1' },
      { name: 'Work', url: 'https://example.invalid/2' },
    ]);
  });

  it('resets on a fresh header, so a re-list does not double up', () => {
    const collector = new NotebookCollector();
    collector.push('Available Notebooks:');
    collector.push('1. Personal (https://example.invalid/1)');
    collector.push('Available Notebooks:');
    collector.push('1. Personal (https://example.invalid/1)');
    expect(collector.count).toBe(1);
  });

  it('de-duplicates a replayed line', () => {
    const collector = new NotebookCollector();
    const line = '1. Personal (https://example.invalid/1)';
    expect(collector.push(line)).toBe(true);
    expect(collector.push(line)).toBe(true);
    expect(collector.count).toBe(1);
  });

  it('ignores lines that are not listings', () => {
    const collector = new NotebookCollector();
    expect(collector.push('[Oct 02 20:39:57] [INFO] Connecting to OneNote...')).toBe(false);
    expect(collector.count).toBe(0);
  });

  it('keeps names that contain regex metacharacters intact', () => {
    const collector = new NotebookCollector();
    collector.push('1. Work (Q1) (https://example.invalid/1)');
    expect(collector.list()[0]!.name).toBe('Work (Q1)');
  });

  it('returns a copy, so a caller cannot mutate the collector', () => {
    const collector = new NotebookCollector();
    collector.push('1. Personal (https://example.invalid/1)');
    collector.list().push({ name: 'Injected', url: null });
    expect(collector.count).toBe(1);
  });
});

describe('errorFromLines', () => {
  it('maps a missing auth file', () => {
    expect(errorFromLines(['Error: Authentication file not found: /data/x/auth.json'], 1)).toBe('no_auth');
  });

  it('maps a login failure, which exits 0', () => {
    expect(errorFromLines(['Authentication failed or cancelled:'], 0)).toBe('bad_credentials');
  });

  it('maps the --non-interactive fail-fast', () => {
    expect(
      errorFromLines(['--non-interactive requires either --notebook <name> or --notebook-link <url>.'], 2),
    ).toBe('no_target');
  });

  it('maps a notebook that disappeared', () => {
    expect(errorFromLines(['Notebook "X" not found in list. Available: Y'], 1)).toBe('notebook_not_found');
  });

  it('maps a dead tab', () => {
    expect(errorFromLines(['Unexpected internal failure during the export (this is a bug):'], 1)).toBe('crashed');
  });

  it('maps a partial run', () => {
    expect(errorFromLines(['Export finished with errors - 3 item(s) could not be exported.'], 0)).toBe(
      'export_partial',
    );
  });

  it('does not treat exit 0 as success for a login', () => {
    // The trap in one assertion: a zero code with a failure line is a failure.
    expect(errorFromLines(['Authentication failed or cancelled:'], 0)).not.toBe('unknown');
    expect(errorFromLines(['Authentication failed or cancelled:'], 0)).toBe('bad_credentials');
  });

  it('does not report an export failure for a login that merely exited non-zero', () => {
    // The fallback is kind-aware. A non-zero exit meant "export" back when only
    // exports could exit non-zero; now that a login can, the kind is the only
    // thing separating the two.
    expect(errorFromLines([], 1, 'login')).toBe('bad_credentials');
    expect(errorFromLines([], 1, 'export')).toBe('export_failed');
    expect(errorFromLines([], 1, 'check')).toBe('auth_unverified');
  });

  it('maps each check reason to the advice it needs', () => {
    // `expired` and `stayed_unauthenticated` both mean sign in again.
    // `unverifiable` must not: the check itself failed, usually the network.
    expect(errorFromLines(['Not authenticated (expired). redirected'], 1, 'check')).toBe('auth_expired');
    expect(
      errorFromLines(['Not authenticated (stayed_unauthenticated). never rendered'], 1, 'check'),
    ).toBe('auth_expired');
    expect(
      errorFromLines(['Not authenticated (unverifiable). net::ERR_TIMED_OUT'], 1, 'check'),
    ).toBe('auth_unverified');
    expect(errorFromLines(['Not authenticated (no_auth_file). does not exist'], 1, 'check')).toBe('no_auth');
  });

  it('maps the 0.1.9 unusable-auth-file failure to no_auth', () => {
    // Not `bad_credentials`: the credentials were accepted, there was simply
    // nothing to log in with afterwards.
    expect(
      errorFromLines(
        ['Login reached the authenticated interface but the auth file is not usable (missing): x'],
        1,
        'login',
      ),
    ).toBe('no_auth');
  });

  it('returns unknown when nothing conclusive was logged', () => {
    expect(errorFromLines(['something entirely unexpected'], 0)).toBe('unknown');
  });

  it('falls back to the exit code when the log says nothing', () => {
    expect(errorFromLines([], 1)).toBe('export_failed');
    expect(errorFromLines([], 2)).toBe('no_target');
  });
});

describe('captured output', () => {
  it('parses every line of the real failed-login stdout', () => {
    const lines = fixture('login-failed-0.1.9.stdout.txt');
    const parsed = lines.map(parseLine);
    expect(parsed.every((p) => p.prefixed)).toBe(true);
    // The version line is how this fixture proves which package it came from.
    expect(parsed[0]!.text).toContain('Authentication Module: v0.1.9 starting...');
    expect(parsed.some((p) => p.text.includes('Attempting automated login for'))).toBe(true);
  });

  it('reads the closing line 0.1.9 added to a failed login', () => {
    const lines = fixture('login-failed-0.1.9.stderr.txt');
    const last = parseLine(lines.at(-1)!);
    expect(last.level).toBe('error');
    expect(last.text).toMatch(/login failed \(exit 1\)/);
    // It is a summary, not a new failure mode: the diagnosis is still in the
    // lines above it.
    expect(classify(last.text).kind).toBe('none');
  });

  it('classifies the real failed-login stderr, stack lines included', () => {
    const lines = fixture('login-failed-0.1.9.stderr.txt');
    // Real output, in order: a specific failure, then the generic
    // "Authentication failed or cancelled:", then the thrown Error and its stack.
    expect(classify(parseLine(lines[0]!).text)).toEqual({ kind: 'none' });
    expect(classify(parseLine(lines[1]!).text)).toEqual({ kind: 'login-failed' });
    for (const line of lines.slice(2)) {
      expect(classify(parseLine(line).text).kind).not.toBe('login-success');
    }
  });

  it('finds no login-success anywhere in a real failed login', () => {
    // The assertion the exit-code trap demands: a failed login must never be
    // readable as a success, whichever stream is consulted.
    const all = [
      ...fixture('login-failed-0.1.9.stdout.txt'),
      ...fixture('login-failed-0.1.9.stderr.txt'),
    ].map((l) => classify(parseLine(l).text).kind);
    expect(all).not.toContain('login-success');
    expect(all).toContain('login-failed');
  });

  it('classifies the real missing-auth list output', () => {
    const stdout = fixture('list-missing-auth.stdout.txt');
    expect(stdout.map(parseLine).every((p) => p.prefixed)).toBe(true);

    const stderr = fixture('list-missing-auth.stderr.txt');
    // First line is the generic "Failed to list notebooks.", the second carries
    // the actual diagnosis. Only the second is actionable.
    expect(classify(parseLine(stderr[0]!).text)).toEqual({ kind: 'none' });
    expect(classify(parseLine(stderr[1]!).text)).toEqual({ kind: 'no-auth' });

    const joined = stderr.map((l) => parseLine(l).text).join('\n');
    expect(errorFromLines([joined], 1)).toBe('no_auth');
  });

  it('classifies the real export fail-fast output', () => {
    const lines = fixture('export-no-target.stderr.txt');
    const joined = lines.map((l) => parseLine(l).text).join('\n');
    expect(classify(parseLine(lines[0]!).text)).toEqual({ kind: 'no-target' });
    expect(errorFromLines([joined], 2)).toBe('no_target');
  });

  it('classifies the real export missing-auth output', () => {
    const stdout = fixture('export-missing-auth.stdout.txt');
    expect(stdout.map(parseLine).every((p) => p.prefixed)).toBe(true);
    const stderr = fixture('export-missing-auth.stderr.txt');
    const joined = stderr.map((l) => parseLine(l).text).join('\n');
    expect(errorFromLines([joined], 1)).toBe('no_auth');
  });

  it('walks the hand-written successful export end to end', () => {
    const lines = fixture('export-success.hand-written.txt').map(parseLine);
    const signals = lines.map((p) => classify(p.text));
    const pages = signals.filter((s) => s.kind === 'page-exported');
    expect(pages).toHaveLength(2);
    expect(signals.filter((s) => s.kind === 'export-complete')).toHaveLength(1);
    expect(signals.filter((s) => s.kind === 'export-partial')).toHaveLength(2);
    expect(signals.filter((s) => s.kind === 'export-crashed')).toHaveLength(1);
    expect(signals.find((s) => s.kind === 'notebook-not-found')).toMatchObject({
      available: ['Personal', 'Work', 'Recipes & "stuff"'],
    });
    // The final total of the successful run, not the earlier partial's.
    const totals = signals.filter((s) => s.kind === 'total-pages');
    expect(totals.map((t) => (t as { pages: number }).pages)).toContain(41);
  });

  it('finds both MFA shapes in the hand-written login capture', () => {
    const lines = fixture('hand-written.txt').map(parseLine);
    const signals = lines.map((p) => classify(p.text));
    expect(signals.filter((s) => s.kind === 'mfa-code')).toHaveLength(1);
    expect(signals.filter((s) => s.kind === 'mfa-number')).toHaveLength(1);
    expect(signals.filter((s) => s.kind === 'login-success')).toHaveLength(2);
  });
});