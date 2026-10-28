import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@code-conductor/runtime/interview': fileURLToPath(new URL('./packages/runtime/src/interview.ts', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup-git-env.ts'],
    // Git-heavy tests take several times longer on Windows (process start, NTFS, Defender):
    // on the owner's workstation 44 of them passed only once given more than 5 s (2026-10-19).
    // Linux keeps the default, so CI still catches a test that hangs.
    testTimeout: process.platform === 'win32' ? 60_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 10_000,
  },
});
