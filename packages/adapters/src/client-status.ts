import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolated } from '@code-conductor/core/processes';

/**
 * Sign-in state as the official client itself reports it. Code Conductor never reads
 * credential files or tokens (AGENTS.md §9): it runs the client's documented status
 * command and keeps only the state, the billing class and the client's own short name
 * for the method. Anything it does not recognise is `unknown`, which never counts as
 * signed in or as subscription billing.
 */
export interface ClientAuthStatus {
  state: 'authenticated' | 'unauthenticated' | 'unknown';
  /** Whether that sign-in uses the subscription or a separately billed credential. */
  billing: 'subscription' | 'separately_billed' | 'unknown';
  /** The client's name for the method, for example `claude.ai` or `ChatGPT`; never a credential. */
  method?: string;
  /** The official status command that was run. */
  command: string[];
}

type Parsed = Omit<ClientAuthStatus, 'command'>;
const UNKNOWN: Parsed = { state: 'unknown', billing: 'unknown' };
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 64 * 1024;
// Method names come from the client's output; only a short plain label is ever kept.
const label = (value: string): string | undefined => {
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(trimmed) ? trimmed : undefined;
};

export interface ProbeOutcome { status: number | null; stdout: string; stderr: string }

/**
 * Run an official client's diagnostic command (`--version`, its sign-in status) with no
 * prompt and no repository: in an empty private directory, so it cannot pick up a
 * repository's own client configuration, with the given (provider) environment, a
 * timeout and bounded output. Undefined when it could not run or did not finish.
 */
export async function probeClient(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeOutcome | undefined> {
  const directory = mkdtempSync(join(tmpdir(), 'cc-probe-'));
  try {
    const outcome = await runIsolated(command, args, { cwd: directory, env, timeoutMs, maxBytes: PROBE_MAX_BYTES });
    return outcome.timedOut || outcome.status === null ? undefined : outcome;
  } catch { return undefined; } finally { rmSync(directory, { recursive: true, force: true }); }
}

// `claude auth status` prints JSON and exits 0 when signed in, 1 when not. `authMethod`
// is one of none, claude.ai, oauth_token, api_key, api_key_helper or third_party
// (https://code.claude.com/docs/en/cli-reference). oauth_token is a `claude setup-token`
// token, which requires a subscription (https://code.claude.com/docs/en/authentication).
const CLAUDE_BILLING: Record<string, ClientAuthStatus['billing']> = {
  'claude.ai': 'subscription', oauth_token: 'subscription', api_key: 'separately_billed', api_key_helper: 'separately_billed', third_party: 'separately_billed',
};
export function parseClaudeAuthStatus(outcome: ProbeOutcome): Parsed {
  let document: { loggedIn?: unknown; authMethod?: unknown };
  try { document = JSON.parse(outcome.stdout) as typeof document; } catch { return UNKNOWN; }
  if (!document || typeof document !== 'object') return UNKNOWN;
  const method = typeof document.authMethod === 'string' ? label(document.authMethod) : undefined;
  if (outcome.status === 1 || method === 'none' || document.loggedIn === false) return { state: 'unauthenticated', billing: 'unknown' };
  if (outcome.status !== 0 || document.loggedIn !== true || !method) return UNKNOWN;
  return { state: 'authenticated', billing: Object.hasOwn(CLAUDE_BILLING, method) ? CLAUDE_BILLING[method]! : 'unknown', method };
}

// `codex login status` prints one line on stderr and exits 0 when signed in, 1 when not
// (openai/codex codex-rs/cli/src/login.rs). In API-key mode the line ends with a masked
// key, which is never kept. Only a ChatGPT sign-in is the subscription.
export function parseCodexLoginStatus(outcome: ProbeOutcome): Parsed {
  const line = outcome.stderr.split(/\r?\n/).map((item) => item.trim()).find((item) => /^(Logged in using|Not logged in)/.test(item));
  if (!line) return UNKNOWN;
  if (line.startsWith('Not logged in')) return { state: 'unauthenticated', billing: 'unknown' };
  if (outcome.status !== 0) return UNKNOWN;
  if (line.startsWith('Logged in using ChatGPT')) return { state: 'authenticated', billing: 'subscription', method: 'ChatGPT' };
  if (line.startsWith('Logged in using an API key')) return { state: 'authenticated', billing: 'separately_billed', method: 'API key' };
  const method = label(/^Logged in using ([A-Za-z ]+)/.exec(line)?.[1] ?? '');
  return { state: 'authenticated', billing: method && /bedrock/i.test(method) ? 'separately_billed' : 'unknown', ...(method ? { method } : {}) };
}

// `kiro-cli whoami` prints "Logged in with <method>"; exit 1 is a general failure, an
// authentication error among others (https://kiro.dev/docs/reference/cli-commands/,
// /docs/reference/exit-codes/), so only one that says so counts as not signed in. Every
// Kiro sign-in, including KIRO_API_KEY, draws on the subscription's credits
// (https://kiro.dev/docs/getting-started/authentication/).
export function parseKiroWhoami(outcome: ProbeOutcome): Parsed {
  const method = label(/^Logged in with ([^(\r\n]+)/m.exec(outcome.stdout)?.[1] ?? '');
  if (outcome.status === 0 && method) return { state: 'authenticated', billing: 'subscription', method };
  if (outcome.status === 1 && /not logged in/i.test(`${outcome.stdout}\n${outcome.stderr}`)) return { state: 'unauthenticated', billing: 'unknown' };
  return UNKNOWN;
}

const STATUS_COMMANDS: Record<string, { args: string[]; parse: (outcome: ProbeOutcome) => Parsed }> = {
  claude: { args: ['auth', 'status'], parse: parseClaudeAuthStatus },
  codex: { args: ['login', 'status'], parse: parseCodexLoginStatus },
  kiro: { args: ['whoami'], parse: parseKiroWhoami },
};

/** Whether Code Conductor knows the official sign-in status command of this harness. */
export function hasOfficialAuthStatus(harness: string): boolean { return harness in STATUS_COMMANDS; }

/**
 * Ask the official client of `harness` for its sign-in state, running `executable` (the
 * file the launch would run) and reporting the command as `command`.
 */
export async function officialAuthStatus(harness: string, command: string, env: NodeJS.ProcessEnv, executable: string | undefined = command): Promise<ClientAuthStatus> {
  const known = STATUS_COMMANDS[harness];
  if (!known) return { ...UNKNOWN, command: [command] };
  const argv = [command, ...known.args];
  const outcome = executable ? await probeClient(executable, known.args, env) : undefined;
  return { ...(outcome ? known.parse(outcome) : UNKNOWN), command: argv };
}
