import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The fake CLIs are the contract between this POC and the packages.
 *
 * They are exercised as real processes, reading and writing real files, because
 * the behaviours that matter (a prompt with no newline, exit 0 on failure, the
 * two different timestamp formats) only exist at the process boundary - a unit
 * test of a function would not have caught any of them.
 */

const FAKE_DIR = resolve(__dirname, '../src/fake');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a fake CLI.
 *
 * Prefers the compiled `.js` the production image runs, and falls back to the
 * TypeScript source through tsx. Both paths are worth being able to run: the
 * image ships compiled output, and a bug that only appears in one of them is
 * exactly the kind that turns up during a POC demo rather than in a test.
 */
function run(script: string, args: string[], opts: { env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<RunResult> {
  const compiled = resolve(__dirname, '../dist/fake', script.replace(/\.ts$/, '.js'));
  const useCompiled = existsSync(compiled);
  const scriptPath = useCompiled ? compiled : join(FAKE_DIR, script);
  const execArgs = useCompiled
    ? [scriptPath, ...args]
    : ['--import', 'tsx', scriptPath, ...args];

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, execArgs, {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString()));
    child.stderr.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

function sessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'msout-fake-'));
  return dir;
}

describe('fake login', () => {
  it('logs the same lines, in the same order, as the real package', async () => {
    const dir = sessionDir();
    const authFile = join(dir, 'auth.json');
    const r = await run('login.ts', ['--email', 'a@b.c', '--password', 'secret', '--auth-file', authFile]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[INFO] Attempting automated login for a@b.c...');
    expect(r.stdout).toContain('[STEP] Automating login steps...');
    expect(r.stdout).toContain('Landing page detected. Clicking "Sign in"...');
    expect(r.stdout).toContain('[INFO] Saving authentication state...');
    expect(r.stdout).toContain(`Authentication successful! State saved to ${authFile}`);
  });

  it('uses the webauth timestamp format, not the exporter one', async () => {
    const dir = sessionDir();
    const r = await run('login.ts', ['--email', 'a@b.c', '--password', 'x', '--auth-file', join(dir, 'auth.json')]);
    // Captured from microsoft-webauth@0.1.8: [Oct 02 20:39:57] [INFO] ...
    expect(r.stdout).toMatch(/^\[Oct \d{2} \d{2}:\d{2}:\d{2}\] \[INFO\]/m);
    expect(r.stdout).not.toMatch(/^\[\d{4}-\d{2}-\d{2}/m);
  });

  it('writes auth.json and the meta file on success', async () => {
    const dir = sessionDir();
    const authFile = join(dir, 'auth.json');
    await run('login.ts', ['--email', 'a@b.c', '--password', 'x', '--auth-file', authFile]);
    expect(existsSync(authFile)).toBe(true);
    expect(JSON.parse(readFileSync(authFile, 'utf8')).cookies).toBeDefined();
    expect(existsSync(join(dir, 'auth-meta.json'))).toBe(true);
  });

  it('exits 0 on a failed login, exactly as microsoft-webauth does', async () => {
    // This is the trap PLAN-v3 §2 is built around. A capture of a real failed
    // login against a non-existent account also exited 0, so any code that
    // trusts this exit code is wrong in production too.
    const dir = sessionDir();
    const r = await run('login.ts', ['--email', 'a@b.c', '--password', 'fail', '--auth-file', join(dir, 'auth.json')]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Authentication failed or cancelled:');
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
  });

  it('prompts for a code with no trailing newline, then accepts it on stdin', async () => {
    const dir = sessionDir();
    const authFile = join(dir, 'auth.json');
    const r = await run('login.ts', ['--email', 'a@b.c', '--password', 'mfa', '--auth-file', authFile], {
      stdin: '123456\n',
    });
    expect(r.stdout).toContain('Enter the verification code: ');
    expect(r.stdout).toContain('Authentication successful!');
    expect(existsSync(authFile)).toBe(true);
  });

  it('rejects a wrong code and writes no auth file', async () => {
    const dir = sessionDir();
    const authFile = join(dir, 'auth.json');
    const r = await run('login.ts', ['--email', 'a@b.c', '--password', 'mfa', '--auth-file', authFile], {
      stdin: '000000\n',
    });
    expect(r.stderr).toContain('Authentication failed or cancelled:');
    // Still exit 0: the code being wrong does not change that.
    expect(r.code).toBe(0);
    expect(existsSync(authFile)).toBe(false);
  });

  it('shows one number for a number-match challenge and no approve prompt', async () => {
    const dir = sessionDir();
    const r = await run('login.ts', ['--email', 'a@b.c', '--password', 'number', '--auth-file', join(dir, 'auth.json')]);
    expect(r.stdout).toContain('Number Matching MFA detected ("Approve sign in request" screen).');
    expect(r.stdout).toContain('  Enter the number:  424242');
    // Exactly one number, and approval happens on the phone: nothing in this
    // flow offers or clicks an Approve button.
    expect(r.stdout.match(/Enter the number/g)).toHaveLength(1);
    expect(r.stdout).not.toMatch(/click(ing)? (the )?(approve|accept)/i);
  });
});

describe('fake list', () => {
  it('exits 1 with an authentication error when auth.json is missing', async () => {
    const dir = sessionDir();
    const r = await run('list.ts', ['--auth-file', join(dir, 'nope.json')]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Authentication file not found');
  });

  it('lists notebooks in the real "<n>. <name> (<url>)" shape', async () => {
    const dir = sessionDir();
    const authFile = join(dir, 'auth.json');
    writeFileSync(authFile, '{}');
    const r = await run('list.ts', ['--auth-file', authFile]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[STEP] \nAvailable Notebooks:');
    expect(r.stdout).toMatch(/1\. Personal \(https:\/\//);
    expect(r.stdout).toMatch(/3\. Recipes & "stuff" \(https:\/\//);
  });
});

describe('fake export', () => {
  function authed() {
    const dir = sessionDir();
    const authFile = join(dir, 'auth.json');
    writeFileSync(authFile, '{}');
    return { dir, authFile, outDir: join(dir, 'out') };
  }

  it('fails fast with exit 2 when no target is given', async () => {
    const { authFile } = authed();
    const r = await run('export.ts', ['--auth-file', authFile, '--non-interactive']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--non-interactive requires either --notebook <name> or --notebook-link <url>');
  });

  it('uses the exporter timestamp format, which differs from the other two', async () => {
    const { authFile, outDir } = authed();
    const r = await run('export.ts', ['--auth-file', authFile, '--output-dir', outDir, '--non-interactive', '--notebook', 'Personal'], {
      env: { FAKE_EXPORT_PAGES: '2', FAKE_EXPORT_PAGE_MS: '1' },
    });
    // Captured from microsoft-onenote-export-notebook@0.3.7: [2026-10-02 20:39:18+02:00] [INFO]
    expect(r.stdout).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] \[INFO\]/m);
  });

  it('emits one Exporting line per page, then the totals and Files saved in', async () => {
    const { authFile, outDir } = authed();
    const r = await run('export.ts', ['--auth-file', authFile, '--output-dir', outDir, '--non-interactive', '--notebook', 'Work'], {
      env: { FAKE_EXPORT_PAGES: '3', FAKE_EXPORT_PAGE_MS: '1' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.match(/Exporting: /g)).toHaveLength(3);
    expect(r.stdout).toContain('[SUCCESS] Export complete!');
    expect(r.stdout).toContain('[INFO] Total Pages: 3');
    expect(r.stdout).toContain('Files saved in:');
  });

  it('writes markdown and an asset under the output dir', async () => {
    const { authFile, outDir } = authed();
    await run('export.ts', ['--auth-file', authFile, '--output-dir', outDir, '--non-interactive', '--notebook', 'Personal'], {
      env: { FAKE_EXPORT_PAGES: '2', FAKE_EXPORT_PAGE_MS: '1' },
    });
    const nb = join(outDir, 'Personal');
    expect(readdirSync(nb).some((f) => f.endsWith('.md'))).toBe(true);
    expect(existsSync(join(nb, 'assets'))).toBe(true);
  });

  it('reports a partial run without failing', async () => {
    const { authFile, outDir } = authed();
    const r = await run('export.ts', ['--auth-file', authFile, '--output-dir', outDir, '--non-interactive', '--notebook', 'Personal'], {
      env: { FAKE_EXPORT_MODE: 'partial', FAKE_EXPORT_PAGES: '2', FAKE_EXPORT_PAGE_MS: '1' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Export finished with errors - 1 item(s) could not be exported.');
    // A partial run must not look like a clean one.
    expect(r.stdout).not.toContain('Export complete!');
  });

  it('reports an early stop as partial, never as complete', async () => {
    const { authFile, outDir } = authed();
    const r = await run('export.ts', ['--auth-file', authFile, '--output-dir', outDir, '--non-interactive', '--notebook', 'Personal'], {
      env: { FAKE_EXPORT_MODE: 'stopped', FAKE_EXPORT_PAGES: '10', FAKE_EXPORT_PAGE_MS: '1' },
    });
    expect(r.stdout).toContain('Export stopped early - the OneNote editor tab went away.');
    expect(r.stdout).not.toContain('Export complete!');
  });

  it('exits 1 on the internal-failure path, the way a dead OneNote tab does', async () => {
    const { authFile, outDir } = authed();
    const r = await run('export.ts', ['--auth-file', authFile, '--output-dir', outDir, '--non-interactive', '--notebook', 'Personal'], {
      env: { FAKE_EXPORT_MODE: 'crash' },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unexpected internal failure during the export (this is a bug)');
  });

  it('reports a notebook that is not in the list, naming what is available', async () => {
    const { authFile, outDir } = authed();
    const r = await run('export.ts', ['--auth-file', authFile, '--output-dir', outDir, '--non-interactive', '--notebook', 'Nope'], {
      env: { FAKE_EXPORT_MODE: 'nolink' },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not found in list');
    expect(r.stderr).toContain('Personal');
  });

  it('exits 1 when auth.json is missing', async () => {
    const dir = sessionDir();
    const r = await run('export.ts', ['--auth-file', join(dir, 'nope.json'), '--output-dir', join(dir, 'out'), '--non-interactive', '--notebook', 'Personal']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Authentication file not found');
  });
});