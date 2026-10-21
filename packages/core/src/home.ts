import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Code Conductor keeps everything it writes under one folder: ~/.code-conductor, or
// $CODE_CONDUCTOR_HOME. Short-lived working files go under its `tmp` folder, never the
// operating system's temp folder, so a crash leaves them in a place the owner already
// knows about and can delete.

/** The folder Code Conductor writes into. Absolute, so a relative setting cannot land inside a repository. */
export function conductorHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor'));
}

/** Create a new private directory under `<conductor home>/tmp`. The caller removes it when done. */
export function conductorTempDirectory(prefix: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = join(conductorHome(env), 'tmp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return mkdtempSync(join(root, prefix));
}
