import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { GIT_LOCAL_ENV_VARS } from '../packages/git/src/index.js';

// Tests spawn git directly against throwaway repositories. When the suite itself is
// launched from a git hook, Git's exported GIT_DIR/GIT_INDEX_FILE would redirect those
// commands, including fixture commits, onto the contributor's own repository and
// index, so drop them before any test runs.
for (const name of GIT_LOCAL_ENV_VARS) delete process.env[name];

// Packaged-default resolution reads ~/.code-conductor/config.json. Give every test
// file an empty home so a contributor's own preferences (for example a disabled
// harness) cannot change planning or gate selection under test.
const home = mkdtempSync(join(tmpdir(), 'cc-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CODE_CONDUCTOR_HOME;
afterAll(() => rmSync(home, { recursive: true, force: true }));
