import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cliEntry, loadConfig } from '../src/config';

/**
 * Entry-point resolution against the real installed packages.
 *
 * This test exists because of a bug that no fake-mode test could catch: the
 * runner resolved each package's `main` instead of its `bin`, so it executed a
 * library module that defines functions and exits. Every fake-mode test passed,
 * and the first live login died in fifty milliseconds with an exit code and no
 * log output at all.
 *
 * So this asserts against the packages as installed, not against a mock.
 */
const PACKAGES = [
  '@msout/microsoft-webauth',
  '@msout/microsoft-onenote-list-notebooks',
  '@msout/microsoft-onenote-export-notebook',
];

describe('cliEntry', () => {
  it.each(PACKAGES)('resolves %s to a file that exists', (pkg) => {
    const entry = cliEntry(pkg);
    expect(existsSync(entry)).toBe(true);
  });

  it.each(PACKAGES)('resolves %s to the CLI, not the library entry point', (pkg) => {
    const meta = require(`${pkg}/package.json`) as {
      main?: string;
      bin?: string | Record<string, string>;
    };
    const library = require.resolve(pkg);
    // The whole bug in one assertion: these must not be the same file.
    expect(cliEntry(pkg)).not.toBe(library);
    expect(meta.main).toBeTruthy();
  });

  it.each(PACKAGES)('points at a script with a shebang, i.e. a program', (pkg) => {
    const entry = cliEntry(pkg);
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    expect(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('is pinned: the installed version matches package.json', () => {
    // The CLI surface *is* the API here, so a floating range would silently
    // change behaviour without anything in this repo changing.
    const installed = require('@msout/microsoft-webauth/package.json') as { version: string };
    const declared = require('../package.json') as {
      dependencies: Record<string, string>;
    };
    expect(declared.dependencies['@msout/microsoft-webauth']).toBe(installed.version);
  });

  it('throws for a package with no bin, rather than spawning undefined', () => {
    expect(() => cliEntry('@msout/does-not-exist')).toThrow();
  });
});

describe('loadConfig', () => {
  const base = { RUNNER_TOKEN: 't', MSOUT_FAKE: '1' } as NodeJS.ProcessEnv;

  it('refuses to start without a runner token', () => {
    // An empty token is not a secret; the runner is the process that receives
    // passwords, so it must not start as though it were configured.
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/RUNNER_TOKEN/);
    expect(() => loadConfig({ RUNNER_TOKEN: '  ' } as NodeJS.ProcessEnv)).toThrow(/RUNNER_TOKEN/);
  });

  it('reads the fake flag', () => {
    expect(loadConfig(base).fake).toBe(true);
    expect(loadConfig({ RUNNER_TOKEN: 't' }).fake).toBe(false);
  });

  it.each([
    ['LOGIN_TIMEOUT_MS', 'not-a-number'],
    ['EXPORT_TIMEOUT_MS', '0'],
    ['LIST_TIMEOUT_MS', '-5'],
  ])('refuses a nonsensical %s', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(new RegExp(name));
  });

  it('defaults to paths that work inside the compose network', () => {
    const config = loadConfig(base);
    expect(config.dataRoot).toBe('/data');
    expect(config.loginTimeoutMs).toBe(15 * 60_000);
    expect(config.exportTimeoutMs).toBe(90 * 60_000);
  });
});