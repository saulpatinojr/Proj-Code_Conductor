import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Packaged defaults are generated (and git-ignored), so every Vitest entry
// point — `npm test`, `npm run test:watch`, `npx vitest` or an IDE runner —
// regenerates them from the canonical config/ sources before suites load.
export default function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/package-defaults.mjs', import.meta.url))], { stdio: 'inherit' });
}
