import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const files = [
  resolve('apps/vscode/dist/extension.js'),
  resolve('apps/vscode/dist/ccon.js'),
];

const stats = new Map();
for (const file of files) {
  if (!existsSync(file)) throw new Error(`VS Code bundle is missing or empty: ${file}`);
  const stat = statSync(file);
  stats.set(file, stat);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`VS Code bundle is missing or empty: ${file}`);
  }
}

const extension = readFileSync(files[0], 'utf8');
const runtime = readFileSync(files[1], 'utf8');

if (extension.includes("packages/cli/dist/index.js") || extension.includes('npm run build')) {
  throw new Error('Production VS Code extension still references the repository-local development runtime/build path.');
}

if (/from\s+["']@code-conductor\//.test(runtime) || /require\(\s*["']@code-conductor\//.test(runtime) || /import\(\s*["']@code-conductor\//.test(runtime)) {
  throw new Error('Bundled Code Conductor runtime still contains unresolved internal workspace imports.');
}

console.log(`VS Code bundle verified: extension=${stats.get(files[0]).size} bytes runtime=${stats.get(files[1]).size} bytes`);

for (const name of ['manifest.json', 'roles.yaml', 'risk.yaml', 'capabilities.yaml', 'gates.yaml', 'mcp-catalog.yaml']) {
  if (!existsSync(resolve('apps/vscode/defaults', name))) throw new Error(`Missing packaged default: ${name}`);
}

if (!existsSync(resolve('apps/vscode/schema/contracts.schema.json'))) throw new Error('Missing packaged contract schema.');
