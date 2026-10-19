import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BILLING_CREDENTIAL_VARIABLES, BILLING_ROUTING_VARIABLES, configurationInsideRepository, createBuiltinAdapters, KiroAcpAdapter, providerEnvironment, type HarnessExecutionRequest } from '../../packages/adapters/src/index.js';

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
    // Directories are made absolute for the platform (on Windows /home/me becomes C:\home\me).
    expect(env).toEqual({ PATH: '/usr/bin', HOME: resolve('/home/me'), CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token', KIRO_API_KEY: 'subscription-credits' });
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

  it('makes relative client configuration directories absolute, so the probe and the run read the same one', () => {
    const env = providerEnvironment({ PATH: '/usr/bin', HOME: 'home', USERPROFILE: './profile', CLAUDE_CONFIG_DIR: 'cfg', ANTHROPIC_CONFIG_DIR: '/home/me/.anthropic', CODEX_HOME: './codex', XDG_CONFIG_HOME: '/home/me/.config', XDG_DATA_HOME: '/home/me/.local/share' }, '/work/start');
    // On Windows `/home/me/...` is root-relative, not fully absolute, so the absolute-only
    // directories are removed there instead of resolved.
    const absoluteOnly = process.platform === 'win32' ? {} : { ANTHROPIC_CONFIG_DIR: '/home/me/.anthropic', XDG_CONFIG_HOME: '/home/me/.config', XDG_DATA_HOME: '/home/me/.local/share' };
    expect(env).toEqual({ PATH: '/usr/bin', HOME: resolve('/work/start', 'home'), USERPROFILE: resolve('/work/start', 'profile'), CLAUDE_CONFIG_DIR: resolve('/work/start', 'cfg'), CODEX_HOME: resolve('/work/start', 'codex'), ...absoluteOnly });
  });

  it('reports a client configuration directory inside the repository, for that client only', () => {
    const repository = mkdtempSync(join(tmpdir(), 'cc-config-inside-'));
    temps.push(repository);
    const env = { CLAUDE_CONFIG_DIR: join(repository, '.claude-config'), CODEX_HOME: join(repository, '..', 'elsewhere') };
    expect(configurationInsideRepository('claude', repository, env)).toEqual([`CLAUDE_CONFIG_DIR (${env.CLAUDE_CONFIG_DIR})`]);
    expect(configurationInsideRepository('codex', repository, env)).toEqual([]);
    expect(configurationInsideRepository('codex', repository, { CODEX_HOME: repository })).toEqual([`CODEX_HOME (${repository})`]);
    // The Anthropic profile directory counts for Claude Code, including one not created yet.
    expect(configurationInsideRepository('claude', repository, { ANTHROPIC_CONFIG_DIR: join(repository, 'not', 'yet') })).toEqual([`ANTHROPIC_CONFIG_DIR (${join(repository, 'not', 'yet')})`]);
    // A sibling sharing the repository's name as a prefix is outside it.
    expect(configurationInsideRepository('claude', repository, { CLAUDE_CONFIG_DIR: `${repository}-cfg` })).toEqual([]);
    expect(configurationInsideRepository('kiro', repository, env)).toEqual([]);
    // A directory outside the repository that is a symlink into it counts as inside.
    if (process.platform !== 'win32') {
      const elsewhere = mkdtempSync(join(tmpdir(), 'cc-config-link-'));
      temps.push(elsewhere);
      mkdirSync(join(repository, 'cfg'));
      symlinkSync(join(repository, 'cfg'), join(elsewhere, 'claude'));
      expect(configurationInsideRepository('claude', repository, { CLAUDE_CONFIG_DIR: join(elsewhere, 'claude') })).toHaveLength(1);
      // A directory not created yet, below a symlink into the repository.
      expect(configurationInsideRepository('claude', repository, { CLAUDE_CONFIG_DIR: join(elsewhere, 'claude', 'new', 'profile') })).toHaveLength(1);
      // A folder that cannot be examined counts as inside: it cannot be shown to be outside.
      symlinkSync(join(elsewhere, 'loop-b'), join(elsewhere, 'loop-a'));
      symlinkSync(join(elsewhere, 'loop-a'), join(elsewhere, 'loop-b'));
      expect(configurationInsideRepository('claude', repository, { CLAUDE_CONFIG_DIR: join(elsewhere, 'loop-a', 'cfg') })).toEqual([`CLAUDE_CONFIG_DIR (${join(elsewhere, 'loop-a', 'cfg')}; its location cannot be verified)`]);
      // The repository named through a symlink is the same repository.
      symlinkSync(repository, join(elsewhere, 'repo-link'));
      expect(configurationInsideRepository('claude', join(elsewhere, 'repo-link'), { CLAUDE_CONFIG_DIR: join(repository, 'cfg') })).toHaveLength(1);
    }
    // A relative value, as the provider environment resolves it when Code Conductor starts in the repository.
    expect(configurationInsideRepository('claude', repository, providerEnvironment({ CLAUDE_CONFIG_DIR: '.' }, repository))).toEqual([`CLAUDE_CONFIG_DIR (${repository})`]);
  });

  it('removes an empty configuration directory and a relative XDG base directory', () => {
    // Claude Code reads an empty CLAUDE_CONFIG_DIR as its working directory: the
    // repository during a run. The XDG specification says a relative value is ignored.
    // Claude Code also skips a relative Anthropic profile directory.
    const env = providerEnvironment({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '', ANTHROPIC_CONFIG_DIR: 'profiles', CODEX_HOME: '', HOME: '', USERPROFILE: '', XDG_CONFIG_HOME: 'cfg', XDG_DATA_HOME: './data', XDG_STATE_HOME: '', XDG_CACHE_HOME: 'cache' }, '/work/start');
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it.skipIf(process.platform === 'win32')('gives the sign-in probe and the run the same configuration directories', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'cc-fake-claude-'));
    const repository = mkdtempSync(join(tmpdir(), 'cc-config-repo-'));
    temps.push(bin, repository);
    const log = join(bin, 'seen.log');
    // Records, per invocation, what the client would use as its configuration directories.
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$1" "\${CLAUDE_CONFIG_DIR-unset}" "\${XDG_CONFIG_HOME-unset}" >> '${log}'\n[ "$1" = auth ] && echo '{"loggedIn":true,"authMethod":"claude.ai"}'\nexit 0\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const claude = createBuiltinAdapters().get('claude')!;
    const request = { cwd: repository, timeoutMs: 5_000, prompt: 'P', task: { id: 'T' }, assignment: { authority: ['observe'] } } as unknown as HarnessExecutionRequest;
    for (const [configDir, expected] of [['', 'unset'], ['relative-cfg', join(process.cwd(), 'relative-cfg')]] as const) {
      writeFileSync(log, '');
      Object.assign(process.env, { PATH: `${bin}${delimiter}${saved.PATH ?? ''}`, CLAUDE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: 'relative-xdg' });
      await claude.authStatus!();
      await claude.execute(request).catch(() => undefined);
      const seen = readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split('|'));
      expect(seen.map(([first]) => first)).toEqual(['auth', '-p']);
      for (const [, dir, xdg] of seen) { expect(dir).toBe(expected); expect(xdg).toBe('unset'); }
    }
  });

  it('starts Claude with only user and managed settings, in both modes', () => {
    const claude = createBuiltinAdapters().get('claude')!;
    const request = (authority: string[]) => ({ cwd: '/r', timeoutMs: 1, prompt: 'P', task: { id: 'T' }, assignment: { authority } }) as unknown as HarnessExecutionRequest;
    expect(claude.invocation!(request(['observe'])).args).toEqual(['-p', '--output-format', 'json', '--setting-sources', 'user', '--permission-mode', 'plan', '--max-turns', '40', 'P']);
    expect(claude.invocation!(request(['modify_worktree'])).args).toEqual(['-p', '--output-format', 'json', '--setting-sources', 'user', '--permission-mode', 'acceptEdits', '--max-turns', '40', 'P']);
  });

  it.skipIf(process.platform === 'win32')('starts Kiro from an absolute PATH entry only, never one in the working directory', async () => {
    const official = mkdtempSync(join(tmpdir(), 'cc-kiro-official-'));
    const repository = mkdtempSync(join(tmpdir(), 'cc-kiro-planted-'));
    temps.push(official, repository);
    writeFileSync(join(official, 'kiro-cli'), `#!/bin/sh\ntouch '${join(official, 'ran')}'\nexit 1\n`);
    writeFileSync(join(repository, 'kiro-cli'), `#!/bin/sh\ntouch '${join(repository, 'ran')}'\nexit 1\n`);
    chmodSync(join(official, 'kiro-cli'), 0o755);
    chmodSync(join(repository, 'kiro-cli'), 0o755);
    process.env.PATH = `.${delimiter}${official}${delimiter}${saved.PATH ?? ''}`;
    const request = { cwd: repository, timeoutMs: 5_000, prompt: 'P', task: { id: 'T' }, assignment: { authority: ['observe'] } } as unknown as HarnessExecutionRequest;
    await new KiroAcpAdapter().execute(request).catch(() => undefined);
    expect(existsSync(join(official, 'ran'))).toBe(true);
    expect(existsSync(join(repository, 'ran'))).toBe(false);
    // A relative command is never resolved at all, even where that file exists.
    const cwd = process.cwd();
    process.chdir(repository);
    try { for (const command of ['./kiro-cli', 'kiro-cli/../kiro-cli']) expect(new KiroAcpAdapter({ command }).available()).toBe(false); } finally { process.chdir(cwd); }
  });
});
