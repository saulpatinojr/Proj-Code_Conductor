import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realRoot = realpathSync(root);
const names = ['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'];
const files = Object.fromEntries(names.map((name) => [`${name}.yaml`, readFileSync(join(root, 'config', `${name}.yaml`))]));
const manifest = JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) }, null, 2) + '\n';

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
/**
 * The generated folder `target` (relative to the repository), created if missing. It is
 * pruned and rewritten in place, so it must be a plain directory at exactly that place:
 * a symlinked folder, or a symlinked parent, would point the deletes and writes anywhere.
 * Nothing is touched otherwise.
 */
function generatedDirectory(target) {
  const destination = join(root, target);
  const refuse = () => { throw new Error(`Refusing to write generated files: ${target} is not a plain directory inside the repository (a symlink?). Remove it and build again.`); };
  try { if (!same(realpathSync(dirname(destination)), join(realRoot, dirname(target)))) refuse(); } catch (error) { if (error.code) refuse(); throw error; }
  mkdirSync(destination, { recursive: true });
  // A symlink, or a symlinked folder above it, resolves somewhere else.
  if (!same(realpathSync(destination), join(realRoot, target))) refuse();
  return destination;
}
/** Writes a generated file, replacing (never writing through) a symlink or other non-file there. */
function writeGenerated(path, bytes) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isFile()) rmSync(path, { recursive: true, force: true });
  else if (entry && readFileSync(path).equals(Buffer.from(bytes))) return;
  writeFileSync(path, bytes);
}

for (const target of ['packages/policy/defaults', 'apps/vscode/defaults']) {
  const destination = generatedDirectory(target);
  // Build output only: anything not generated now (a renamed default, a stray file) is
  // removed, so packaging can never pick it up. rmSync removes a symlink, not its target.
  const expected = new Set([...Object.keys(files), 'manifest.json']);
  for (const entry of readdirSync(destination)) if (!expected.has(entry)) rmSync(join(destination, entry), { recursive: true, force: true });
  for (const [name, bytes] of [...Object.entries(files), ['manifest.json', manifest]]) writeGenerated(join(destination, name), bytes);
}

// Contract validation reads this relative to its compiled module or the bundled CLI.
const schemaDirectory = generatedDirectory('apps/vscode/schema');
writeGenerated(join(schemaDirectory, 'contracts.schema.json'), readFileSync(join(root, 'packages/schemas/schema/contracts.schema.json')));
