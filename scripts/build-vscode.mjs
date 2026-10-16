import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Bundled CommonJS dependencies still require Node builtins in the ESM output.
const common = {
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, metafile: true,
  banner: { js: "import { createRequire as __ccCreateRequire } from 'node:module'; const require = __ccCreateRequire(import.meta.url);" },
};
const results = [
  await build({ ...common, entryPoints: ['apps/vscode/src/extension.ts'], external: ['vscode'], outfile: 'apps/vscode/dist/extension.js' }),
  await build({ ...common, entryPoints: ['packages/cli/src/index.ts'], outfile: 'apps/vscode/dist/cc.js' }),
];

// Every package with code in either bundle, from esbuild's own record of its inputs. The
// release SBOM is checked against this list (scripts/release-sbom.mjs); it is not shipped.
const packageOf = (file) => {
  for (let directory = dirname(file); directory !== '.' && directory !== dirname(directory); directory = dirname(directory)) {
    try { const { name, version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); if (name && version) return `${name}@${version}`; } catch { /* keep looking */ }
  }
  throw new Error(`No package.json above bundled input ${file}`);
};
const bundled = new Set(results.flatMap((result) => Object.keys(result.metafile.inputs).map(packageOf)));
writeFileSync('apps/vscode/dist/bundled-packages.json', `${JSON.stringify([...bundled].sort(), null, 2)}\n`);
