import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { conductorHome, conductorTempDirectory } from '../../packages/core/src/home.js';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const scratch = (): string => { const path = mkdtempSync(join(tmpdir(), 'cc-home-')); temps.push(path); return path; };

/** Every file of the shipped sources: the packages, the extension and the owner scripts. */
function shippedSources(): string[] {
  const roots = [...readdirSync('packages').map((name) => join('packages', name, 'src')), join('apps', 'vscode', 'src'), join('scripts', 'owner')];
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path); } else if (/\.(ts|mjs|ps1|psm1)$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  return files;
}

describe('Code Conductor home folder', () => {
  it('creates working directories under <home>/tmp, never in the operating system temp folder', () => {
    const home = scratch();
    const directory = conductorTempDirectory('cc-test-', { CODE_CONDUCTOR_HOME: home });
    expect(directory.startsWith(join(resolve(home), 'tmp', 'cc-test-'))).toBe(true);
    expect(statSync(directory).isDirectory()).toBe(true);
    expect(conductorTempDirectory('cc-test-', { CODE_CONDUCTOR_HOME: home })).not.toBe(directory);
  });

  it('resolves a relative CODE_CONDUCTOR_HOME so it cannot land inside a repository', () => {
    expect(conductorHome({ CODE_CONDUCTOR_HOME: 'relative-home' })).toBe(resolve('relative-home'));
  });

  it('defaults to .code-conductor in the home folder', () => {
    expect(conductorHome({})).toBe(join(homedir(), '.code-conductor'));
  });

  it('keeps the shipped sources off the operating system temp folder (regression guard)', () => {
    const offenders = shippedSources().filter((file) => /\btmpdir\(\)|GetTempPath|\/tmp\/|%TEMP%/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the workstation state in the home folder only', () => {
    const offenders = shippedSources().filter((file) => readFileSync(file, 'utf8').includes('CODE_CONDUCTOR_WORKSTATION_STATE'));
    expect(offenders).toEqual([]);
  });
});
