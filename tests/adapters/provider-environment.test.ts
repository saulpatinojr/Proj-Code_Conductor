import { describe, expect, it } from 'vitest';
import { BILLING_CREDENTIAL_VARIABLES, providerEnvironment } from '../../packages/adapters/src/index.js';

describe('provider client environment', () => {
  it('drops separately billed API credentials and repository-redirecting Git variables', () => {
    const env = providerEnvironment({ PATH: '/usr/bin', HOME: '/home/me', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y', KIRO_API_KEY: 'z', GIT_DIR: '/elsewhere/.git', GIT_INDEX_FILE: '/tmp/i', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token' });
    expect(BILLING_CREDENTIAL_VARIABLES).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY', 'KIRO_API_KEY']));
  });
});
