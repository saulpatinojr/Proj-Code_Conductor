import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'];
const files = Object.fromEntries(names.map((name) => [`${name}.yaml`, readFileSync(join(root, 'config', `${name}.yaml`))]));
const manifest = JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) }, null, 2) + '\n';
for (const target of ['packages/policy/defaults', 'apps/vscode/defaults']) {
  const destination = join(root, target);
  mkdirSync(destination, { recursive: true });
  // Build output only: anything not generated now (a renamed default, a stray file) is
  // removed, so packaging can never pick it up.
  const expected = new Set([...Object.keys(files), 'manifest.json']);
  for (const entry of readdirSync(destination)) if (!expected.has(entry)) rmSync(join(destination, entry), { recursive: true, force: true });
  for (const [name, bytes] of [...Object.entries(files), ['manifest.json', manifest]]) {
    const path = join(destination, name);
    let existing;
    try { existing = readFileSync(path); } catch { /* New build output. */ }
    if (!existing?.equals(Buffer.from(bytes))) writeFileSync(path, bytes);
  }
}

// Contract validation reads this relative to its compiled module or the bundled CLI.
const schemaDirectory = join(root, 'apps/vscode/schema');
mkdirSync(schemaDirectory, { recursive: true });
const schema = readFileSync(join(root, 'packages/schemas/schema/contracts.schema.json'));
writeFileSync(join(schemaDirectory, 'contracts.schema.json'), schema);
