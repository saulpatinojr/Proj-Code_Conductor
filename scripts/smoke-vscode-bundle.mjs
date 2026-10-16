import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

// Runs the bundled runtime the way an installed extension does: from an extension folder
// outside this repository, against an unrelated empty folder, with a fresh home and no
// node_modules, APM or repository scaffolding.
//
//   node scripts/smoke-vscode-bundle.mjs                      # layout rebuilt from apps/vscode build output
//   node scripts/smoke-vscode-bundle.mjs --extension <dir>    # an extracted .vsix (its extension/ folder)
//
// With --extension, the folder must hold exactly the files a release ships.
const SHIPPED = [
  /^package\.json$/, /^readme\.md$/i, /^changelog\.md$/i, /^license(\.txt)?$/i,
  /^dist\/(extension|cc)\.js$/, /^defaults\/[a-z-]+\.yaml$/, /^defaults\/manifest\.json$/,
  /^schema\/contracts\.schema\.json$/, /^media\/[a-z-]+\.svg$/,
];
const REQUIRED = ['package.json', 'dist/extension.js', 'dist/cc.js', 'defaults/manifest.json', 'schema/contracts.schema.json'];

function files(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(root, path) : [relative(root, path).split(sep).join('/')];
  });
}

const index = process.argv.indexOf('--extension');
const installed = index >= 0 ? resolve(process.argv[index + 1] ?? '') : undefined;
const temporary = mkdtempSync(join(tmpdir(), 'cc-distribution-smoke-'));
try {
  let extension = join(temporary, 'extension');
  if (installed) {
    const shipped = files(installed);
    const unexpected = shipped.filter((file) => !SHIPPED.some((pattern) => pattern.test(file)));
    assert.deepEqual(unexpected, [], `The package ships files no release should: ${unexpected.join(', ')}`);
    for (const file of REQUIRED) assert.ok(shipped.includes(file), `The package is missing ${file}`);
    // A copy outside this repository, as VS Code installs it under its extensions folder.
    cpSync(installed, extension, { recursive: true });
  } else {
    mkdirSync(join(extension, 'dist'), { recursive: true });
    cpSync(resolve('apps/vscode/dist/cc.js'), join(extension, 'dist', 'cc.js'));
    cpSync(resolve('apps/vscode/defaults'), join(extension, 'defaults'), { recursive: true });
    cpSync(resolve('apps/vscode/schema'), join(extension, 'schema'), { recursive: true });
    writeFileSync(join(extension, 'package.json'), '{"type":"module"}\n');
  }
  const workspace = join(temporary, 'unrelated');
  mkdirSync(workspace);
  const env = { ...process.env, HOME: temporary, USERPROFILE: temporary, CODE_CONDUCTOR_HOME: join(temporary, '.code-conductor') };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const cc = (...args) => execFileSync(process.execPath, [join(extension, 'dist', 'cc.js'), ...args], { cwd: workspace, encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, env });

  const result = JSON.parse(cc('workspace-validate', workspace));
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'workspace');
  assert.equal(result.sources.length, 7);
  if (installed) {
    // The runtime reports the version the package declares, and read-only commands work without any run.
    assert.equal(cc('version').trim(), JSON.parse(readFileSync(join(extension, 'package.json'), 'utf8')).version);
    assert.match(cc('worktrees'), /No Code Conductor agent worktrees recorded/);
  }
  assert.deepEqual(readdirSync(workspace), []);
  console.log(`${installed ? 'Installed VSIX' : 'Standalone bundled'} runtime/defaults: PASS (no source tree, node_modules, APM, or repository scaffolding).`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
