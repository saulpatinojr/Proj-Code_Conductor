import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinAdapters, parseClaudeAuthStatus, parseCodexLoginStatus, parseKiroWhoami, probeClient } from '../../packages/adapters/src/index.js';

const temps: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});
const out = (status: number | null, stdout = '', stderr = '') => ({ status, stdout, stderr });

describe('official sign-in status parsing', () => {
  it('reads claude auth status JSON by its documented authMethod values', () => {
    expect(parseClaudeAuthStatus(out(0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.invalid' })))).toEqual({ state: 'authenticated', billing: 'subscription', method: 'claude.ai' });
    expect(parseClaudeAuthStatus(out(0, JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }))).billing).toBe('subscription');
    for (const method of ['api_key', 'api_key_helper', 'third_party']) expect(parseClaudeAuthStatus(out(0, JSON.stringify({ loggedIn: true, authMethod: method }))).billing).toBe('separately_billed');
    expect(parseClaudeAuthStatus(out(1, JSON.stringify({ loggedIn: false, authMethod: 'none' })))).toEqual({ state: 'unauthenticated', billing: 'unknown' });
    expect(parseClaudeAuthStatus(out(0, JSON.stringify({ loggedIn: true, authMethod: 'something_new' })))).toEqual({ state: 'authenticated', billing: 'unknown', method: 'something_new' });
    // Names of the billing table's own prototype are not methods.
    for (const method of ['constructor', 'toString', 'hasOwnProperty']) expect(parseClaudeAuthStatus(out(0, JSON.stringify({ loggedIn: true, authMethod: method }))).billing).toBe('unknown');
    // Only the client's own success exit counts.
    expect(parseClaudeAuthStatus(out(2, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))).state).toBe('unknown');
    // Not JSON, or no explicit loggedIn: never counts as signed in. Personal fields are not kept.
    expect(parseClaudeAuthStatus(out(0, 'Logged in'))).toEqual({ state: 'unknown', billing: 'unknown' });
    expect(parseClaudeAuthStatus(out(0, JSON.stringify({ authMethod: 'claude.ai' }))).state).toBe('unknown');
    expect(JSON.stringify(parseClaudeAuthStatus(out(0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.invalid' }))))).not.toContain('example.invalid');
  });

  it('reads codex login status from stderr and never keeps the masked key', () => {
    expect(parseCodexLoginStatus(out(0, '', 'Logged in using ChatGPT\n'))).toEqual({ state: 'authenticated', billing: 'subscription', method: 'ChatGPT' });
    const key = parseCodexLoginStatus(out(0, '', 'Logged in using an API key - sk-proj-***ABCDE\n'));
    expect(key).toEqual({ state: 'authenticated', billing: 'separately_billed', method: 'API key' });
    expect(JSON.stringify(key)).not.toContain('ABCDE');
    expect(parseCodexLoginStatus(out(0, '', 'Logged in using Amazon Bedrock API key\n')).billing).toBe('separately_billed');
    expect(parseCodexLoginStatus(out(0, '', 'Logged in using personal access token\n'))).toEqual({ state: 'authenticated', billing: 'unknown', method: 'personal access token' });
    expect(parseCodexLoginStatus(out(1, '', 'Not logged in\n'))).toEqual({ state: 'unauthenticated', billing: 'unknown' });
    expect(parseCodexLoginStatus(out(1, '', 'Error checking login status: boom\n')).state).toBe('unknown');
    // Only the client's own exit status counts: a success line with a failing exit is not trusted.
    expect(parseCodexLoginStatus(out(1, '', 'Logged in using ChatGPT\n')).state).toBe('unknown');
  });

  it('reads kiro-cli whoami, where every sign-in draws on subscription credits', () => {
    expect(parseKiroWhoami(out(0, 'Logged in with Builder ID\nEmail: user@example.invalid\n'))).toEqual({ state: 'authenticated', billing: 'subscription', method: 'Builder ID' });
    expect(parseKiroWhoami(out(0, 'Logged in with IAM Identity Center (https://my-org.awsapps.com/start)\nProfile:\nx\n')).method).toBe('IAM Identity Center');
    expect(parseKiroWhoami(out(1, '', 'Not logged in'))).toEqual({ state: 'unauthenticated', billing: 'unknown' });
    expect(parseKiroWhoami(out(0, 'something else\n')).state).toBe('unknown');
    // Exit 1 is any general failure; only one that says so means not signed in.
    expect(parseKiroWhoami(out(1, '', 'error: invalid arguments')).state).toBe('unknown');
    expect(parseKiroWhoami(out(2, 'Logged in with Builder ID\n')).state).toBe('unknown');
  });
});

describe.skipIf(process.platform === 'win32')('official sign-in status probes', () => {
  function fakeClient(name: string, script: string): string {
    const bin = mkdtempSync(join(tmpdir(), 'cc-fake-status-'));
    temps.push(bin);
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    return bin;
  }

  it('runs in an empty private directory with only the environment it is given', async () => {
    const bin = fakeClient('probe-me', 'pwd; ls -A; echo "LEAK=${CC_PROBE_SECRET:-none}"');
    process.env.CC_PROBE_SECRET = 'should-not-pass';
    const outcome = await probeClient(join(bin, 'probe-me'), [], { PATH: process.env.PATH ?? '' });
    const [cwd, ...rest] = (outcome?.stdout ?? '').trim().split('\n');
    expect(cwd).not.toBe(process.cwd());
    expect(cwd).toMatch(/cc-probe-/);
    expect(rest).toEqual(['LEAK=none']);
  });

  it('asks the client with the provider environment, so a removed API key cannot decide the answer', async () => {
    fakeClient('claude', 'if [ "$1 $2" != "auth status" ]; then exit 2; fi\nif [ -n "$ANTHROPIC_API_KEY" ]; then echo \'{"loggedIn":true,"authMethod":"api_key"}\'; else echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; fi');
    process.env.ANTHROPIC_API_KEY = 'metered';
    const status = await createBuiltinAdapters().get('claude')!.authStatus!();
    expect(status).toEqual({ state: 'authenticated', billing: 'subscription', method: 'claude.ai', command: ['claude', 'auth', 'status'] });
  });

  it('reports unknown when the client does not answer in time', async () => {
    const bin = fakeClient('slow-client', 'sleep 5; echo late');
    const started = Date.now();
    expect(await probeClient(join(bin, 'slow-client'), [], { PATH: process.env.PATH ?? '' }, 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('asks and launches the same client file, never one found through a relative PATH entry', async () => {
    const official = fakeClient('claude', 'if [ "$1" = "--version" ]; then echo "9.9.9 (official)"; exit 0; fi\nif [ "$1 $2" = "auth status" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi\necho "official $*"');
    const repository = mkdtempSync(join(tmpdir(), 'cc-planted-client-'));
    temps.push(repository);
    writeFileSync(join(repository, 'claude'), '#!/bin/sh\necho "planted $*"; echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'\n');
    chmodSync(join(repository, 'claude'), 0o755);
    process.env.PATH = `.${delimiter}${official}${delimiter}${saved.PATH ?? ''}`;
    const cwd = process.cwd();
    process.chdir(repository);
    try {
      const adapter = createBuiltinAdapters().get('claude')!;
      expect(adapter.version()).toBe('9.9.9 (official)');
      expect((await adapter.authStatus!()).state).toBe('authenticated');
      const assignment = { id: 'A-1', taskId: 'T-1', agentId: 'r', role: 'reviewer', stance: 'critical', provider: 'anthropic', harness: 'claude', surface: 'cli', billingChannel: 'subscription', authority: ['observe'], dependsOn: [] };
      const executed = await adapter.execute({ cwd: repository, timeoutMs: 10_000, prompt: 'p', task: { id: 'T-1' }, assignment } as never);
      expect(executed.stdout).toMatch(/^official /);
      // The repository's own Claude Code settings and .mcp.json are not read for the run.
      expect(executed.stdout).toContain('--setting-sources user');
    } finally { process.chdir(cwd); }
  });

  it('reports unknown when the client cannot be run', async () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'cc-empty-path-'));
    temps.push(process.env.PATH);
    const status = await createBuiltinAdapters().get('codex')!.authStatus!();
    expect(status).toEqual({ state: 'unknown', billing: 'unknown', command: ['codex', 'login', 'status'] });
  });
});
