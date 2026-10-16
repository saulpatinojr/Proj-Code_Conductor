import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(run().status).toBe(0);
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
  });
});
