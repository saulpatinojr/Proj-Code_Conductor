import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentAssignment, TaskEnvelope } from '@code-conductor/schemas';

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
  execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome>;
}

function commandExists(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

function commandVersion(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', shell: false, timeout: 15000 });
  return result.status === 0 ? (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] : undefined;
}

function appendTail(current: string, next: string, limit = 256 * 1024): string {
  const combined = current + next;
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

async function settleChild(
  child: ReturnType<typeof spawn>,
  closeState: { exitCode: number | null; signal: NodeJS.Signals | null },
): Promise<void> {
  if (closeState.exitCode !== null || closeState.signal !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    child.once('close', done);
    setTimeout(() => {
      if (closeState.exitCode === null && closeState.signal === null) child.kill('SIGKILL');
      resolve();
    }, 750).unref();
  });
}

function argsFor(id: string, request: HarnessExecutionRequest): string[] {
  const writeAllowed = request.assignment.authority.includes('modify_worktree');
  switch (id) {
    case 'codex':
      return ['exec', '--json', '--ask-for-approval', 'never', '--sandbox', writeAllowed ? 'workspace-write' : 'read-only', '--cd', request.cwd, request.prompt];
    case 'claude':
      return writeAllowed
        ? ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-turns', '40', request.prompt]
        : ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--max-turns', '20', request.prompt];
    default:
      return [request.prompt];
  }
}

class SubprocessAdapter implements HarnessAdapter {
  readonly executionSurface: HarnessExecutionSurface = 'cli';
  constructor(public readonly id: string, public readonly provider: string, public readonly command: string) {}
  available(): boolean { return commandExists(this.command); }
  version(): string | undefined { return this.available() ? commandVersion(this.command) : undefined; }
  invocation(request: HarnessExecutionRequest): { command: string; args: string[] } { return { command: this.command, args: argsFor(this.id, request) }; }
  execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    const args = argsFor(this.id, request);
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: request.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout = appendTail(stdout, chunk); });
      child.stderr.on('data', (chunk: string) => { stderr = appendTail(stderr, chunk); });
      child.on('error', reject);
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, request.timeoutMs);
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ harness: this.id, surface: this.executionSurface, command: this.command, args, exitCode, signal, stdout, stderr, startedAt, finishedAt: new Date().toISOString(), timedOut });
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

  constructor(options: KiroAcpAdapterOptions = {}) {
    this.command = options.command ?? 'kiro-cli';
    this.args = options.args ?? ['acp'];
    this.env = options.env ?? process.env;
  }

  available(): boolean { return commandExists(this.command); }
  version(): string | undefined { return this.command === 'kiro-cli' && this.available() ? commandVersion(this.command) : undefined; }
  invocation(_request: HarnessExecutionRequest): { command: string; args: string[] } { return { command: this.command, args: [...this.args] }; }

  async execute(request: HarnessExecutionRequest): Promise<HarnessExecutionOutcome> {
    const startedAt = new Date().toISOString();
    const child = spawn(this.command, this.args, { cwd: request.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
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
