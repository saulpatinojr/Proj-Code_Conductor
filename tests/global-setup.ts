import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Packaged defaults are generated (and git-ignored), so every Vitest entry
// point — `npm test`, `npm run test:watch`, `npx vitest` or an IDE runner —
// regenerates them and builds referenced workspace packages before suites load.
// This also makes standalone Vitest runs work in a checkout without dist files.
export default function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/package-defaults.mjs', import.meta.url))], { stdio: 'inherit' });
  execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-b', '--pretty', 'false'], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' });
}
