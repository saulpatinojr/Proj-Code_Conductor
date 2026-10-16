import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentAssignment, TaskEnvelope } from '@code-conductor/schemas';
import { KILL_GRACE_MS, resolveExecutable, spawnIsolated, terminateGroup } from '@code-conductor/core/processes';
import { withoutGitLocalEnv } from '@code-conductor/git';
import { officialAuthStatus, type ClientAuthStatus } from './client-status.js';

export { hasOfficialAuthStatus, officialAuthStatus, parseClaudeAuthStatus, parseCodexLoginStatus, parseKiroWhoami, probeClient, type ClientAuthStatus, type ProbeOutcome } from './client-status.js';

export type HarnessExecutionSurface = 'cli' | 'acp' | 'platform' | 'manual' | 'ide' | 'local' | 'mcp_api';

export interface HarnessExecutionRequest {
  task: TaskEnvelope;
  assignment: AgentAssignment;
  cwd: string;
  timeoutMs: number;
  prompt: string;
}

export interface HarnessExecutionOutcome {
  harness: string;
  surface: HarnessExecutionSurface;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  timedOut: boolean;
  /** The client's final message, from its documented machine-readable output (see `finalMessage`). */
  message?: string;
}

/** Harnesses whose documented machine-readable output carries a final message. */
export function hasFinalMessage(harness: string): boolean { return harness === 'claude' || harness === 'codex'; }

/**
 * The final message from a client's documented machine-readable output, so only what
 * the model said last is read for its result, never tool or command output:
 * - Claude Code `-p --output-format json` prints one JSON object with the text in
 *   `result` (https://code.claude.com/docs/en/headless).
 * - Codex `exec --json` prints JSON Lines events; the last `item.completed` whose item is
 *   an `agent_message` holds the final text (https://developers.openai.com/codex/non-interactive-mode).
 * Undefined when the output does not have that shape.
 */
export function finalMessage(harness: string, stdout: string): string | undefined {
  if (!hasFinalMessage(harness)) return undefined;
  const parse = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch { return undefined; } };
  if (harness === 'claude') {
    const value = parse(stdout.trim()) as { result?: unknown } | undefined;
    return typeof value?.result === 'string' ? value.result : undefined;
  }
  if (harness === 'codex') {
    let message: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const event = parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } } | undefined;
      if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') message = event.item.text;
    }
    return message;
  }
  return undefined;
}

export interface HarnessAdapter {
  id: string;
  provider: string;
  executionSurface: HarnessExecutionSurface;
  command: string | null;
  available(): boolean;
  version(): string | undefined;
  /** The exact process invocation execute() would use, so pre-action approval can bind it. */
  invocation?(request: HarnessExecutionRequest): { command: string; args: string[] };
  /** Sign-in state from the official client's own status command, for clients that have one. */
  authStatus?(): Promise<ClientAuthStatus>;
  execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome>;
}

/**
 * The one file a client command runs as: an absolute path as given, or a plain name found
 * on absolute PATH entries only. The version probe, the sign-in probe and the launch all
 * use it, so they cannot reach different programs: a relative entry such as
 * `node_modules/.bin`, an empty entry, or (on Windows) the working directory would
 * otherwise resolve against the repository a client runs in.
 */
function clientExecutable(command: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  return resolveExecutable(command).path;
}

// Like the sign-in status probe: no repository, so a repository's own client
// configuration cannot change what the client reports.
function commandVersion(executable: string): string | undefined {
  const directory = mkdtempSync(join(tmpdir(), 'cc-probe-'));
  try {
    const result = spawnSync(executable, ['--version'], { cwd: directory, env: providerEnvironment(), encoding: 'utf8', shell: false, timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true });
    return result.status === 0 ? (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] : undefined;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// Provider clients run isolated from the controlling terminal, in their own process
// group, and are reaped on exit or interruption (shared with gate commands; see
// @code-conductor/core/processes for what this does and does not contain).
export { spawnIsolated, terminateGroup } from '@code-conductor/core/processes';

// Subscription-first billing (D-019/D-056 policy): the environment variables that make a
// provider client use separately billed API credentials instead of its subscription
// sign-in are not passed to it. Claude Code ranks cloud-provider selection, bearer
// tokens, API keys, named profiles and federation above /login
// (code.claude.com/docs/en/authentication, /env-vars); Codex uses an API key when one
// is set. Not removed: subscription credentials such as CLAUDE_CODE_OAUTH_TOKEN, and
// KIRO_API_KEY, whose usage draws on the Kiro subscription's credits and which a
// browser sign-in outranks (kiro.dev/docs/getting-started/authentication). Credentials
// a client reads from its own configuration files are not affected by this.
export const BILLING_CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'PERPLEXITY_API_KEY',
] as const;
/** Variables that select a separately billed provider, endpoint or credential source. */
export const BILLING_ROUTING_VARIABLES = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
] as const;
// Git's repository-local variables are removed too, so an inherited GIT_DIR or
// GIT_INDEX_FILE cannot point the client's own git at another repository.
// A relative client configuration directory would name a different directory for the
// sign-in probe (an empty temporary directory) and for the run (the repository), so the
// repository could supply the run's "user" settings. They are made absolute once, against
// the directory Code Conductor was started in, as CODE_CONDUCTOR_HOME is.
const CLIENT_CONFIG_DIRECTORIES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME'] as const;
export function providerEnvironment(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): NodeJS.ProcessEnv {
  const scrubbed = withoutGitLocalEnv(env);
  for (const name of [...BILLING_CREDENTIAL_VARIABLES, ...BILLING_ROUTING_VARIABLES]) delete scrubbed[name];
  for (const name of CLIENT_CONFIG_DIRECTORIES) {
    const value = scrubbed[name];
    if (value && !isAbsolute(value)) scrubbed[name] = resolve(cwd, value);
  }
  return scrubbed;
}

function appendTail(current: string, next: string, limit = 256 * 1024): string {
  const combined = current + next;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

async function settleChild(
  child: ReturnType<typeof spawn>,
  closeState: { exitCode: number | null; signal: NodeJS.Signals | null },
): Promise<void> {
  if (closeState.exitCode !== null || closeState.signal !== null) { terminateGroup(child, 'SIGKILL'); return; }
  terminateGroup(child, 'SIGTERM');
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    child.once('close', done);
    setTimeout(() => {
      if (closeState.exitCode === null && closeState.signal === null) child.kill('SIGKILL');
      resolve();
    }, 750).unref();
  });
  terminateGroup(child, 'SIGKILL');
}

function argsFor(id: string, request: HarnessExecutionRequest): string[] {
  const writeAllowed = request.assignment.authority.includes('modify_worktree');
  switch (id) {
    case 'codex':
      return ['exec', '--json', '--ask-for-approval', 'never', '--sandbox', writeAllowed ? 'workspace-write' : 'read-only', '--cd', request.cwd, request.prompt];
    case 'claude':
      // --setting-sources user: the repository's .claude/settings*.json and .mcp.json are
      // not read. Under -p Claude Code would otherwise apply their env block, apiKeyHelper
      // and hooks without a trust prompt, so a repository could switch a subscription run
      // to its own credential or endpoint after the sign-in check, which sees only your
      // user and managed settings (https://code.claude.com/docs/en/permissions, "What
      // runs before you trust a folder"). CLAUDE.md and skills still load.
      return writeAllowed
        ? ['-p', '--output-format', 'json', '--setting-sources', 'user', '--permission-mode', 'acceptEdits', '--max-turns', '40', request.prompt]
        : ['-p', '--output-format', 'json', '--setting-sources', 'user', '--permission-mode', 'plan', '--max-turns', '20', request.prompt];
    default:
      return [request.prompt];
  }
}

class SubprocessAdapter implements HarnessAdapter {
  readonly executionSurface: HarnessExecutionSurface = 'cli';
  constructor(public readonly id: string, public readonly provider: string, public readonly command: string) {}
  available(): boolean { return clientExecutable(this.command) !== undefined; }
  version(): string | undefined { const executable = clientExecutable(this.command); return executable ? commandVersion(executable) : undefined; }
  invocation(request: HarnessExecutionRequest): { command: string; args: string[] } { return { command: this.command, args: argsFor(this.id, request) }; }
  authStatus(): Promise<ClientAuthStatus> { return officialAuthStatus(this.id, this.command, providerEnvironment(), clientExecutable(this.command)); }
  execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    const args = argsFor(this.id, request);
    const startedAt = new Date().toISOString();
    const executable = clientExecutable(this.command);
    if (!executable) return Promise.reject(new Error(`${this.command} was not found on an absolute PATH entry.`));
    return new Promise((resolve, reject) => {
      const child = spawnIsolated(executable, args, { cwd: request.cwd, env: providerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // stdout/stderr are pipes per the stdio option above.
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => { stdout = appendTail(stdout, chunk); });
      child.stderr!.on('data', (chunk: string) => { stderr = appendTail(stderr, chunk); });
      child.on('error', reject);
      let escalation: NodeJS.Timeout | undefined;
      let release: NodeJS.Timeout | undefined;
      // A client that ignores SIGTERM is killed after a grace period instead of hanging the run.
      const timer = setTimeout(() => {
        timedOut = true;
        terminateGroup(child, 'SIGTERM');
        escalation = setTimeout(() => terminateGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      }, request.timeoutMs);
      let settled = false;
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(escalation); clearTimeout(release);
        // The client exited; do not let anything it left running keep touching the worktree.
        terminateGroup(child, 'SIGKILL');
        const message = finalMessage(this.id, stdout);
        resolve({ harness: this.id, surface: this.executionSurface, command: this.command, args, exitCode, signal, stdout, stderr, startedAt, finishedAt: new Date().toISOString(), timedOut, ...(message !== undefined ? { message } : {}) });
      };
      child.on('close', finish);
      // A descendant that left the process group can keep the output pipes open after
      // the client exits, so 'close' would never come: stop reading after a grace period.
      child.on('exit', (exitCode, signal) => {
        terminateGroup(child, 'SIGKILL');
        release = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(exitCode, signal); }, KILL_GRACE_MS);
      });
    });
  }
}

export interface KiroAcpAdapterOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Kiro adapter using the official stable ACP v1 TypeScript SDK over stdio.
 *
 * The client advertises filesystem read/write and terminal capabilities as
 * unavailable/false. Permission requests are cancelled by default until the
 * installed Kiro client and permission model pass workstation validation.
 */
export class KiroAcpAdapter implements HarnessAdapter {
  readonly id = 'kiro';
  readonly provider = 'aws';
  readonly executionSurface: HarnessExecutionSurface = 'acp';
  readonly command: string;
  readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  /** Only the official `kiro-cli` is asked for its sign-in state, as only it reports a version. */
  readonly authStatus?: () => Promise<ClientAuthStatus>;

  constructor(options: KiroAcpAdapterOptions = {}) {
    this.command = options.command ?? 'kiro-cli';
    this.args = options.args ?? ['acp'];
    this.env = options.env ?? providerEnvironment();
    if (this.command === 'kiro-cli') this.authStatus = () => officialAuthStatus('kiro', this.command, this.env, clientExecutable(this.command));
  }

  available(): boolean { return clientExecutable(this.command) !== undefined; }
  version(): string | undefined { const executable = this.command === 'kiro-cli' ? clientExecutable(this.command) : undefined; return executable ? commandVersion(executable) : undefined; }
  invocation(_request: HarnessExecutionRequest): { command: string; args: string[] } { return { command: this.command, args: [...this.args] }; }

  async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    const startedAt = new Date().toISOString();
    const executable = clientExecutable(this.command);
    if (!executable) throw new Error(`${this.command} was not found on an absolute PATH entry.`);
    const child = spawnIsolated(executable, this.args, { cwd: request.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const spawnFailure = new Promise<never>((_, reject) => child.once('error', reject));
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill('SIGTERM');
      throw new Error(`Kiro ACP process did not expose the required stdio pipes for ${this.command}.`);
    }
    const closeState: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: null, signal: null };
    let assistantOutput = '';
    let stderr = '';
    let timedOut = false;
    let sessionId: string | undefined;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = appendTail(stderr, chunk); });
    child.on('close', (exitCode, signal) => { closeState.exitCode = exitCode; closeState.signal = signal; });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );

    try {
      const sessionRun = acp
        .client({ name: 'code-conductor' })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          const kind = ctx.params.toolCall.kind ?? 'other';
          stderr = appendTail(stderr, `[ACP permission cancelled] toolCallId=${ctx.params.toolCall.toolCallId} kind=${kind}\n`);
          return { outcome: { outcome: 'cancelled' } };
        })
        .onNotification(acp.methods.client.session.update, (ctx) => {
          const update = ctx.params.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            assistantOutput = appendTail(assistantOutput, update.content.text);
          }
        })
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          const session = await ctx.request(acp.methods.agent.session.new, {
            cwd: request.cwd,
            mcpServers: [],
          });
          sessionId = session.sessionId;

          let timer: NodeJS.Timeout | undefined;
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(async () => {
              timedOut = true;
              try {
                if (sessionId) {
                  stderr = appendTail(stderr, `[ACP cancel requested] sessionId=${sessionId}\n`);
                  void ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {
                    // Best effort only. Process teardown below is authoritative.
                  });
                }
              } catch {
                // Teardown below remains authoritative even if cancellation cannot be delivered.
              }
              reject(new Error(`Kiro ACP prompt timed out after ${request.timeoutMs}ms.`));
            }, request.timeoutMs);
          });

          try {
            await Promise.race([
              ctx.request(acp.methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: 'text', text: request.prompt }],
              }),
              timeout,
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        });
      await Promise.race([sessionRun, spawnFailure]);
    } catch (error) {
      if (!timedOut) throw error;
      stderr = appendTail(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      try { await stream.writable.close(); } catch { /* process/stream may already be closed */ }
      await settleChild(child, closeState);
    }

    return {
      harness: this.id,
      surface: this.executionSurface,
      command: this.command,
      args: [...this.args],
      exitCode: closeState.exitCode,
      signal: closeState.signal,
      stdout: assistantOutput,
      stderr,
      startedAt,
      finishedAt: new Date().toISOString(),
      timedOut,
    };
  }
}

class UnsupportedAdapter implements HarnessAdapter {
  command = null;
  constructor(
    public readonly id: string,
    public readonly provider: string,
    public readonly executionSurface: HarnessExecutionSurface,
    private readonly reason: string,
  ) {}
  available(): boolean { return false; }
  version(): string | undefined { return undefined; }
  async execute(_request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> { throw new Error(this.reason); }
}

export function createBuiltinAdapters(): Map<string, HarnessAdapter> {
  return new Map<string, HarnessAdapter>([
    ['codex', new SubprocessAdapter('codex', 'openai', 'codex')],
    ['claude', new SubprocessAdapter('claude', 'anthropic', 'claude')],
    ['kiro', new KiroAcpAdapter()],
    ['antigravity', new UnsupportedAdapter('antigravity', 'google', 'ide', 'Antigravity unattended automation is disabled pending current permission/sandbox revalidation; use the interactive/native Google lane.')],
    ['copilot-github', new UnsupportedAdapter('copilot-github', 'github', 'platform', 'GitHub Copilot Gatekeeper is a GitHub platform integration, not a generic subprocess worker.')],
    ['perplexity', new UnsupportedAdapter('perplexity', 'perplexity', 'manual', 'Perplexity Pro subscription mode is human-in-the-loop; automated official MCP/API mode is separately billed and disabled by default.')],
    ['internal-validator', new UnsupportedAdapter('internal-validator', 'code-conductor', 'local', 'Internal validation is executed by the deterministic gate runner.')],
  ]);
}
