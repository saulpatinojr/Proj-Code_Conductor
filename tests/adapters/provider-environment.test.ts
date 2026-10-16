import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BILLING_CREDENTIAL_VARIABLES, BILLING_ROUTING_VARIABLES, createBuiltinAdapters, KiroAcpAdapter, providerEnvironment, type HarnessExecutionRequest } from '../../packages/adapters/src/index.js';

const temps: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

const METERED = { ANTHROPIC_API_KEY: 'a', AWS_BEARER_TOKEN_BEDROCK: 'b', ANTHROPIC_FOUNDRY_API_KEY: 'c', CODEX_API_KEY: 'd', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gateway.example.invalid', ANTHROPIC_PROFILE: 'console', ANTHROPIC_FEDERATION_RULE_ID: 'rule', ANTHROPIC_ORGANIZATION_ID: 'org' };

describe('provider client environment', () => {
  it('drops separately billed credentials, provider selection and repository-redirecting Git variables', () => {
    const env = providerEnvironment({ PATH: '/usr/bin', HOME: '/home/me', ...METERED, OPENAI_API_KEY: 'y', GIT_DIR: '/elsewhere/.git', GIT_INDEX_FILE: '/tmp/i', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token', KIRO_API_KEY: 'subscription-credits' });
    // Kiro API keys draw on the Kiro subscription's credits, so they are not metered billing.
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token', KIRO_API_KEY: 'subscription-credits' });
    expect([...BILLING_CREDENTIAL_VARIABLES, ...BILLING_ROUTING_VARIABLES]).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'PERPLEXITY_API_KEY', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']));
  });

  it.skipIf(process.platform === 'win32')('is the environment the subprocess and Kiro adapters actually start clients with', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'cc-fake-client-'));
    temps.push(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nenv\n');
    chmodSync(join(bin, 'claude'), 0o755);
    Object.assign(process.env, METERED, { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, CC_PROVIDER_ENV_PROBE: 'kept' });
    const request = { cwd: bin, timeoutMs: 10_000, prompt: 'probe', task: { id: 'T-1' }, assignment: { authority: ['observe'] } } as unknown as HarnessExecutionRequest;
    const outcome = await createBuiltinAdapters().get('claude')!.execute(request);
    expect(outcome.stdout).toContain('CC_PROVIDER_ENV_PROBE=kept');
    for (const name of Object.keys(METERED)) expect(outcome.stdout).not.toMatch(new RegExp(`^${name}=`, 'm'));
    const kiro = (new KiroAcpAdapter() as unknown as { env: NodeJS.ProcessEnv }).env;
    expect(kiro.CC_PROVIDER_ENV_PROBE).toBe('kept');
    for (const name of Object.keys(METERED)) expect(kiro[name]).toBeUndefined();
  });
});
