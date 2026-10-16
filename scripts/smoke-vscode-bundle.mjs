import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
// With --extension, the folder may hold only regular files matching the release allowlist,
// and must hold every required one. (Packaging itself includes only the "files" listed in
// apps/vscode/package.json.)
const SHIPPED = [
  /^package\.json$/, /^readme\.md$/i, /^changelog\.md$/i, /^license(\.txt)?$/i,
  /^dist\/(extension|cc)\.js$/, /^defaults\/[a-z-]+\.yaml$/, /^defaults\/manifest\.json$/,
  /^schema\/contracts\.schema\.json$/, /^media\/[a-z-]+\.svg$/,
];
const REQUIRED = ['package.json', 'dist/extension.js', 'dist/cc.js', 'defaults/manifest.json', 'schema/contracts.schema.json'];

// Directory entries are not followed: a symlink or other special file is reported as such,
// so it never passes as one of the allowed names.
function files(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(root, path);
    const name = relative(root, path).split(sep).join('/');
    return [entry.isFile() ? name : `${name} (not a regular file)`];
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
    // The defaults are exactly the files the packaged manifest names, no more and no fewer.
    const listed = JSON.parse(readFileSync(join(installed, 'defaults', 'manifest.json'), 'utf8')).files;
    const defaults = Object.keys(listed).map((name) => `defaults/${name}`).sort();
    assert.deepEqual(shipped.filter((file) => /^defaults\/.*\.yaml$/.test(file)).sort(), defaults, 'The packaged defaults differ from defaults/manifest.json');
    for (const [name, digest] of Object.entries(listed)) assert.equal(createHash('sha256').update(readFileSync(join(installed, 'defaults', name))).digest('hex'), digest, `defaults/${name} does not match its digest in defaults/manifest.json`);
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
  // A fresh home: nothing from this machine's Code Conductor, Git or Node configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODE_CONDUCTOR_|GIT_|NODE_OPTIONS$|NODE_PATH$|XDG_)/i.test(name)));
  Object.assign(env, { HOME: temporary, USERPROFILE: temporary, APPDATA: join(temporary, 'AppData', 'Roaming'), LOCALAPPDATA: join(temporary, 'AppData', 'Local'), CODE_CONDUCTOR_HOME: join(temporary, '.code-conductor') });
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
