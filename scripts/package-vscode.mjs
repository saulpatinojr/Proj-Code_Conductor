import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'apps', 'vscode');
const releaseRoot = join(root, 'release');
const publisher = process.env.VSCE_PUBLISHER?.trim();

if (!publisher) throw new Error('VSCE_PUBLISHER is required. Configure the intended Marketplace publisher ID before packaging.');
if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(publisher)) throw new Error(`VSCE_PUBLISHER contains unsupported characters: ${publisher}`);

for (const file of ['dist/extension.js', 'dist/ccon.js', 'media/conductor.svg']) {
  if (!existsSync(join(appRoot, file))) throw new Error(`Missing VS Code release input ${file}. Run npm run build first.`);
}

mkdirSync(releaseRoot, { recursive: true });
const stage = mkdtempSync(join(releaseRoot, '.vscode-stage-'));

try {
  cpSync(appRoot, stage, { recursive: true });
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) cpSync(join(root, file), join(stage, file));

  const manifestPath = join(stage, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.publisher = publisher;
  manifest.license = 'Apache-2.0';
  manifest.repository = { type: 'git', url: 'https://github.com/saulpatinojr/Proj-Code_Conductor.git' };
  manifest.homepage = 'https://github.com/saulpatinojr/Proj-Code_Conductor#readme';
  manifest.bugs = { url: 'https://github.com/saulpatinojr/Proj-Code_Conductor/issues' };
  delete manifest.private;
  // The extension and ccon runtime are bundled, so Marketplace packages should
  // not carry the workspace node_modules graph. @types/vscode stays so vsce
  // still refuses API types newer than engines.vscode.
  delete manifest.dependencies;
  manifest.devDependencies = { '@types/vscode': manifest.devDependencies['@types/vscode'] };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const out = join(releaseRoot, `code-conductor-${manifest.version}.vsix`);
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(npx, ['--no-install', 'vsce', 'package', '--no-dependencies', '--out', out], {
    cwd: stage,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) throw new Error(`vsce package failed with exit code ${String(result.status)}`);
  if (!existsSync(out)) throw new Error(`vsce reported success but did not create ${out}`);
  console.log(out);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
