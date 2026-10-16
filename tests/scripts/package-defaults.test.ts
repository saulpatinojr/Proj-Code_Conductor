import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The script prunes and rewrites generated folders, so it runs here in a scratch copy of
// the repository layout, never in the checkout.
const NAMES = ['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'];
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

function scratch(): { repo: string; outside: string; run: () => ReturnType<typeof spawnSync> } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cc-package-defaults-')));
  temps.push(base);
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  for (const dir of ['scripts', 'config', 'packages/policy', 'packages/schemas/schema', 'apps/vscode']) mkdirSync(join(repo, dir), { recursive: true });
  cpSync(resolve('scripts/package-defaults.mjs'), join(repo, 'scripts/package-defaults.mjs'));
  for (const name of NAMES) cpSync(resolve(`config/${name}.yaml`), join(repo, `config/${name}.yaml`));
  cpSync(resolve('packages/schemas/schema/contracts.schema.json'), join(repo, 'packages/schemas/schema/contracts.schema.json'));
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.txt'), 'keep me\n');
  return { repo, outside, run: () => spawnSync(process.execPath, [join(repo, 'scripts/package-defaults.mjs')], { encoding: 'utf8' }) };
}

describe.skipIf(process.platform === 'win32')('scripts/package-defaults.mjs', () => {
  it('writes exactly the current defaults, removing strays and replacing (not following) symlinked entries', () => {
    const { repo, outside, run } = scratch();
    expect(run().status).toBe(0);
    const defaults = join(repo, 'apps/vscode/defaults');
    writeFileSync(join(defaults, 'zz-stray.yaml'), 'stray: true\n');
    rmSync(join(defaults, 'roles.yaml'));
    symlinkSync(join(outside, 'sentinel.txt'), join(defaults, 'roles.yaml'));
    // Stray links to a folder and to a file are removed, never followed.
    mkdirSync(join(outside, 'folder'));
    writeFileSync(join(outside, 'folder', 'inner.txt'), 'keep me too\n');
    symlinkSync(join(outside, 'folder'), join(defaults, 'stray-folder'));
    symlinkSync(join(outside, 'sentinel.txt'), join(defaults, 'stray-file.yaml'));
    // A hard link to a file elsewhere is replaced, not written through.
    rmSync(join(repo, 'packages/policy/defaults/risk.yaml'));
    linkSync(join(outside, 'sentinel.txt'), join(repo, 'packages/policy/defaults/risk.yaml'));
    expect(run().status).toBe(0);
    expect(readFileSync(join(outside, 'folder', 'inner.txt'), 'utf8')).toBe('keep me too\n');
    expect(readFileSync(join(repo, 'packages/policy/defaults/risk.yaml'), 'utf8')).toBe(readFileSync(resolve('config/risk.yaml'), 'utf8'));
    expect(lstatSync(join(outside, 'sentinel.txt')).nlink).toBe(1);
    expect(readFileSync(join(repo, 'apps/vscode/schema/contracts.schema.json'), 'utf8')).toBe(readFileSync(resolve('packages/schemas/schema/contracts.schema.json'), 'utf8'));
  });

  it('replaces a hard link even with identical content, a folder at a file name, and leftover temporary files', () => {
    const { repo, outside, run } = scratch();
    expect(run().status).toBe(0);
    const defaults = join(repo, 'apps/vscode/defaults');
    // Identical content would otherwise be left alone, still linked to the file elsewhere.
    writeFileSync(join(outside, 'roles-copy.yaml'), readFileSync(join(defaults, 'roles.yaml')));
    rmSync(join(defaults, 'roles.yaml'));
    linkSync(join(outside, 'roles-copy.yaml'), join(defaults, 'roles.yaml'));
    rmSync(join(defaults, 'gates.yaml'));
    mkdirSync(join(defaults, 'gates.yaml'));
    writeFileSync(join(repo, 'apps/vscode/schema/contracts.schema.json.tmp'), 'left behind\n');
    expect(run().status).toBe(0);
    expect(lstatSync(join(defaults, 'roles.yaml')).nlink).toBe(1);
    expect(lstatSync(join(outside, 'roles-copy.yaml')).nlink).toBe(1);
    expect(lstatSync(join(defaults, 'gates.yaml')).isFile()).toBe(true);
    expect(readdirSync(join(repo, 'apps/vscode/schema'))).toEqual(['contracts.schema.json']);
    expect(readdirSync(defaults).sort()).toEqual([...NAMES.map((name) => `${name}.yaml`), 'manifest.json'].sort());
    expect(lstatSync(join(defaults, 'roles.yaml')).isFile()).toBe(true);
    expect(readFileSync(join(defaults, 'roles.yaml'), 'utf8')).toBe(readFileSync(resolve('config/roles.yaml'), 'utf8'));
    expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep me\n');
  });

  it.each([
    ['a symlinked defaults folder', 'apps/vscode/defaults'],
    ['a symlinked policy defaults folder', 'packages/policy/defaults'],
    ['a symlinked parent folder', 'apps/vscode'],
    ['a symlinked schema folder', 'apps/vscode/schema'],
  ])('refuses %s and deletes or writes nothing through it', (_label, link) => {
    const { repo, outside, run } = scratch();
    rmSync(join(repo, link), { recursive: true, force: true });
    symlinkSync(outside, join(repo, link));
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/is not a plain directory inside the repository/);
    expect(readdirSync(outside)).toEqual(['sentinel.txt']);
    expect(existsSync(join(repo, 'config/roles.yaml'))).toBe(true);
    // All folders are checked first: nothing was created or generated anywhere.
    if (!link.startsWith('packages/policy')) expect(existsSync(join(repo, 'packages/policy/defaults'))).toBe(false);
    expect(existsSync(join(repo, 'apps/vscode/schema/contracts.schema.json'))).toBe(false);
  });

  it('refuses a file where a generated folder belongs, with the same message', () => {
    const { repo, run } = scratch();
    writeFileSync(join(repo, 'apps/vscode/defaults'), 'not a folder\n');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/apps\/vscode\/defaults is not a plain directory inside the repository/);
    expect(existsSync(join(repo, 'packages/policy/defaults'))).toBe(false);
  });
});
