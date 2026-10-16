import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realRoot = realpathSync(root);
const names = ['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'];
const files = Object.fromEntries(names.map((name) => [`${name}.yaml`, readFileSync(join(root, 'config', `${name}.yaml`))]));
const manifest = JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) }, null, 2) + '\n';

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const refuse = (target) => { throw new Error(`Refusing to write generated files: ${target} is not a plain directory inside the repository (its parent is missing, or it or a parent is a symlink or a file). Fix that and build again.`); };

/**
 * Generated folders (relative to the repository) and the files each holds. Each is pruned
 * and rewritten in place, so it must be a plain directory at exactly that place: a
 * symlinked folder, or a symlinked parent, would point the deletes and writes anywhere.
 */
const generated = {
  'packages/policy/defaults': { ...files, 'manifest.json': manifest },
  'apps/vscode/defaults': { ...files, 'manifest.json': manifest },
  // Contract validation reads this relative to its compiled module or the bundled CLI.
  'apps/vscode/schema': { 'contracts.schema.json': readFileSync(join(root, 'packages/schemas/schema/contracts.schema.json')) },
};

/** Checks a generated folder without creating or changing anything. */
function checkGeneratedDirectory(target) {
  const destination = join(root, target);
  try { if (!same(realpathSync(dirname(destination)), join(realRoot, dirname(target)))) refuse(target); } catch (error) { if (error.code) refuse(target); throw error; }
  let entry;
  try { entry = lstatSync(destination, { throwIfNoEntry: false }); } catch { refuse(target); }
  // A symlink, or a symlinked folder above it, resolves somewhere else.
  if (entry && (!entry.isDirectory() || !same(realpathSync(destination), join(realRoot, target)))) refuse(target);
  return destination;
}

/**
 * Writes a folder's generated files, each by replacing its directory entry: the file is
 * staged in a private folder next to it and renamed over it, so a symlink or a hard link
 * there is replaced, never written through. Files that are already current are left alone.
 */
function writeGenerated(destination, contents) {
  const pending = Object.entries(contents).filter(([name, bytes]) => {
    const entry = lstatSync(join(destination, name), { throwIfNoEntry: false });
    return !(entry?.isFile() && entry.nlink === 1 && readFileSync(join(destination, name)).equals(Buffer.from(bytes)));
  });
  if (!pending.length) return;
  // Outside the folder, so a concurrent build's prune cannot delete a file before it is
  // renamed; mkdtemp makes it new and private, so nothing can be planted in it. A build
  // killed mid-write can leave it behind (ignored by Git, never packaged).
  const staging = mkdtempSync(join(dirname(destination), `.${basename(destination)}.staging-`));
  try {
    for (const [name, bytes] of pending) {
      const path = join(destination, name);
      if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) rmSync(path, { recursive: true, force: true });
      writeFileSync(join(staging, name), bytes, { flag: 'wx' });
      renameSync(join(staging, name), path);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Every generated folder is checked before anything is created or changed.
const destinations = Object.keys(generated).map(checkGeneratedDirectory);
Object.entries(generated).forEach(([target, contents], index) => {
  const destination = destinations[index];
  mkdirSync(destination, { recursive: true });
  if (!same(realpathSync(destination), join(realRoot, target))) refuse(target);
  // Build output only: anything not generated now (a renamed default, a stray or
  // leftover file) is removed. rmSync removes a symlink, not its target.
  for (const entry of readdirSync(destination)) if (!Object.hasOwn(contents, entry)) rmSync(join(destination, entry), { recursive: true, force: true });
  writeGenerated(destination, contents);
});
