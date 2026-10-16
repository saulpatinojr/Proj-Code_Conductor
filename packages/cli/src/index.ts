#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentAssignment, RiskClass, TaskEnvelope } from '@code-conductor/schemas';
import { validateRepositoryConfig, loadConfiguration } from '@code-conductor/policy';
import { readBoundedFile } from '@code-conductor/policy/bounded-read';
import { assignmentPrompt, createTask, DEFAULT_SHELL, executeTask, formatCommand, printable, importRunManifest, nextActions, planTask, parseAgentResult, type NextAction } from '@code-conductor/runtime';
import { RunStore } from '@code-conductor/evidence';
import { defaultWorktreeRoot } from '@code-conductor/git';
import { assertContract, type RunManifest } from '@code-conductor/schemas';
import { createBuiltinAdapters } from '@code-conductor/adapters';
import { WorkstationStore, type HarnessTrustMode } from '@code-conductor/workstation';
import { apmAudit, apmLockPresent, apmTargets, inventoryNativeCustomizations } from '@code-conductor/apm-adapter';
import { detectRepositoryProfiles, loadMcpCatalog, selectMcpServers } from '@code-conductor/mcp';
import { githubAuthStatus, pullRequestChecks, pullRequestStatus } from '@code-conductor/github-gate';
import { ContextOptimizer } from '@code-conductor/context-optimizer';
import { TerminalApprover } from './approval-prompt.js';
import { terminalText } from './terminal-text.js';

const VERSION = '0.1.0';
function hasCommand(command: string): boolean { const probe = process.platform === 'win32' ? 'where' : 'which'; return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0; }
function getOption(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function listOption(args: string[], name: string): string[] { return getOption(args, name)?.split(',').map((value) => value.trim()).filter(Boolean) ?? []; }

function printValidation(root: string): number {
  const report = validateRepositoryConfig(root);
  for (const issue of report.issues) console.log(`${issue.level === 'error' ? 'ERROR' : 'WARN'} ${issue.code}${issue.path ? ` [${issue.path}]` : ''}: ${issue.message}`);
  console.log(report.ok ? 'Code Conductor repository validation: PASS' : 'Code Conductor repository validation: FAIL');
  return report.ok ? 0 : 1;
}

function validateWorkspace(root: string): number {
  try {
    const configuration = ['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'] as const;
    const sources = configuration.map((name) => ({ name, sources: loadConfiguration(root, name).sources }));
    console.log(JSON.stringify({ ok: true, mode: 'workspace', repository: root, sources }, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isCodeConductorSource(root: string): boolean {
  try { return (JSON.parse(readBoundedFile(join(root, 'package.json'), 1048576).toString('utf8')) as { name?: unknown }).name === '@code-conductor/root'; }
  catch { return false; }
}

function vscodeExtensions(): Set<string> {
  if (!hasCommand('code')) return new Set();
  const result = spawnSync('code', ['--list-extensions'], { encoding: 'utf8', shell: false, timeout: 15000 });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split(/\r?\n/).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function doctor(root: string): number {
  const requiredClients = [['node', ['node']], ['git', ['git']], ['github', ['gh']]] as const;
  const optionalTools = [['apm', ['apm']], ['terraform', ['terraform']], ['ansible', ['ansible']], ['powershell', ['pwsh']], ['azure-cli', ['az']], ['aws-cli', ['aws']], ['gcloud', ['gcloud']], ['kubectl', ['kubectl']], ['helm', ['helm']]] as const;
  const workstation = new WorkstationStore();
  const state = workstation.load();
  const adapters = createBuiltinAdapters();
  const extensions = vscodeExtensions();
  console.log(`Code Conductor doctor ${VERSION}`);
  let missingRequired = false;

  for (const [name, candidates] of requiredClients) {
    const found = candidates.some(hasCommand);
    console.log(`${found ? 'OK' : 'MISSING'} required ${name} (${candidates.join('|')})`);
    if (!found) missingRequired = true;
  }

  let signIn: Record<string, { command?: string[]; docs?: string }> = {};
  try { signIn = Object.fromEntries(Object.entries(loadConfiguration<{ harnesses: Record<string, { sign_in?: { command?: string[]; docs?: string } }> }>(root, 'capabilities').document.harnesses).map(([id, harness]) => [id, harness.sign_in ?? {}])); }
  catch { /* Reported by the configuration check below. */ }
  for (const [id, adapter] of adapters) {
    if (id === 'internal-validator') continue;
    const hint = signIn[id];
    const official = hint?.command ? ` sign-in=\`${formatCommand(hint.command)}\`${hint.docs ? ` (${hint.docs})` : ''}` : '';
    console.log(`${adapter.available() ? 'OK' : 'INFO'} harness ${id}: surface=${adapter.executionSurface} command=${adapter.command ?? 'platform/manual'} version=${adapter.version() ?? 'unknown/not-applicable'}${official}`);
  }
  console.log('INFO authentication stays in each official client; installed or detected does not mean signed in, healthy or trusted. Code Conductor never reads or stores credentials.');

  const knownExtensions = [
    ['claude', 'anthropic.claude-code'],
    ['codex', 'openai.chatgpt'],
    ['github-copilot', 'github.copilot'],
    ['github-copilot-chat', 'github.copilot-chat'],
    ['github-pr', 'github.vscode-pull-request-github'],
  ] as const;
  if (hasCommand('code')) {
    for (const [name, id] of knownExtensions) console.log(`${extensions.has(id) ? 'OK' : 'INFO'} vscode-extension ${name}: ${id}`);
  } else {
    console.log('INFO vscode-extension inventory unavailable: `code` CLI not found on PATH.');
  }

  for (const [name, candidates] of optionalTools) {
    const found = candidates.some(hasCommand);
    console.log(`${found ? 'OK' : 'INFO'} tool ${name}: ${found ? candidates.find(hasCommand) : 'not found (optional unless repository profile requires it)'}`);
  }

  for (const [key, record] of Object.entries(state.harnesses)) console.log(`TRUST ${key}: read=${Boolean(record.readValidatedAt || record.modifyValidatedAt)} modify=${Boolean(record.modifyValidatedAt)} version=${record.clientVersion ?? 'unknown'}`);
  for (const variable of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'PERPLEXITY_API_KEY']) if (process.env[variable]) console.log(`WARN billing.api_credential_detected: ${variable} is set; subscription-first policy may be bypassed. Value is intentionally not displayed.`);
  if (hasCommand('gh')) console.log(`${githubAuthStatus(root).ok ? 'OK' : 'WARN'} github-auth`);
  if (hasCommand('apm')) { console.log(`${apmTargets(root).ok ? 'OK' : 'WARN'} apm-targets`); console.log(`${apmLockPresent(root) ? 'OK' : 'WARN'} apm-lock`); }
  const inventory = inventoryNativeCustomizations(root);
  const count = (kind: string, scope: string): number => inventory.entries.filter((entry) => entry.kind === kind && entry.scope === scope).length;
  console.log(`INFO native-inventory: project agents=${count('agent', 'project')} skills=${count('skill', 'project')}; user agents=${count('agent', 'user')} skills=${count('skill', 'user')}${inventory.truncated ? ' (truncated)' : ''}. Details: cc agents`);
  if (inventory.unmanagedProjectPaths.length) console.log(`INFO native-inventory.unmanaged: ${inventory.unmanagedProjectPaths.length} project file(s) not recorded in apm.lock.yaml (informational; apm audit is authoritative): ${inventory.unmanagedProjectPaths.join(', ')}`);
  let configStatus = 0;
  try {
    for (const name of ['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'] as const) loadConfiguration(root, name);
    console.log('OK packaged runtime configuration (not source-repository scaffold validation)');
    if (isCodeConductorSource(root)) console.log('INFO source-repository: run `cc validate .` for the strict Code Conductor configuration/scaffold check.');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); configStatus = 1; }
  return missingRequired || configStatus !== 0 ? 1 : 0;
}

function availableHarnesses(): Set<string> {
  const adapters = createBuiltinAdapters();
  return new Set([...adapters.entries()].filter(([, adapter]) => adapter.available()).map(([id]) => id));
}

function plan(args: string[]): number {
  const root = resolve(getOption(args, '--repo') ?? '.'); const objective = getOption(args, '--objective'); const risk = (getOption(args, '--risk') ?? 'R1') as RiskClass;
  if (!objective) { console.error('ERROR plan.objective_required: --objective is required.'); return 2; }
  if (!['R0', 'R1', 'R2', 'R3', 'R4'].includes(risk)) { console.error(`ERROR plan.invalid_risk: ${risk}`); return 2; }
  const task = createTask(objective, risk, root, listOption(args, '--specializations'));
  console.log(JSON.stringify(planTask(root, task, { availableHarnesses: availableHarnesses() }), null, 2)); return 0;
}

async function run(args: string[]): Promise<number> {
  const root = resolve(getOption(args, '--repo') ?? '.'); const objective = getOption(args, '--objective'); const risk = (getOption(args, '--risk') ?? 'R1') as RiskClass;
  if (!objective) { console.error('ERROR run.objective_required: --objective is required.'); return 2; }
  const execute = args.includes('--execute'); const workstation = new WorkstationStore();
  const task = createTask(objective, risk, root, listOption(args, '--specializations'));
  const outcome = await executeTask(root, task, { execute, keepWorktrees: !args.includes('--cleanup-worktrees'), isHarnessTrusted: (harness, mode, surface) => workstation.isTrusted(harness, mode, surface), approver: new TerminalApprover(), ...(listOption(args, '--gate-profiles').length ? { gateProfiles: listOption(args, '--gate-profiles') } : {}) });
  console.log(JSON.stringify({ runId: outcome.plan.runId, execute, manifestPath: outcome.manifestPath, mergeDecision: outcome.manifest.mergeDecision, assignments: outcome.plan.assignments.map((a) => ({ role: a.role, harness: a.harness, surface: a.surface, stance: a.stance, authority: a.authority })), approvals: (outcome.manifest.approvals ?? []).map((a) => ({ action: a.action, recipient: a.recipient, status: a.status, requestDigest: a.requestDigest })), nextActions: nextActions(outcome.manifest, { worktreeRoot: defaultWorktreeRoot() }).map(presentAction), pendingExternal: outcome.pendingExternal.map((a) => a.id), worktrees: outcome.worktrees.map((w) => ({ path: w.path, branch: w.branch, baseSha: w.baseSha })) }, null, 2));
  return outcome.manifest.mergeDecision && outcome.manifest.mergeDecision.decision !== 'ready' ? 1 : 0;
}

async function harnessSmoke(args: string[]): Promise<number> {
  const harness = args[0]; const mode = (getOption(args, '--mode') ?? 'read') as HarnessTrustMode;
  if (!harness || !['read', 'modify'].includes(mode)) { console.error('Usage: cc harness-smoke <codex|claude|kiro> --mode <read|modify> [--ack-kiro-policy]'); return 2; }
  if (harness === 'antigravity') { console.error('BLOCKED: Antigravity unattended smoke is disabled pending current permission/sandbox revalidation.'); return 1; }
  const adapter = createBuiltinAdapters().get(harness);
  if (!adapter?.available()) { console.error(`ERROR: harness ${harness} is not available.`); return 1; }

  const workstation = new WorkstationStore();
  if (harness === 'kiro') {
    if (adapter.executionSurface !== 'acp') {
      console.error(`BLOCKED: Kiro smoke requires the approved ACP surface; adapter exposed ${adapter.executionSurface}.`);
      return 1;
    }
    if (!args.includes('--ack-kiro-policy')) {
      console.error('BLOCKED: Kiro ACP smoke may consume Kiro subscription credits. Read the current Kiro subscription/automation policy and rerun with --ack-kiro-policy only if this ACP-compatible development workflow is permitted for your account/use case.');
      return 1;
    }
    if (mode === 'modify' && !workstation.isTrusted('kiro', 'read', 'acp')) {
      console.error('BLOCKED: Run and pass the Kiro ACP read smoke before attempting modify smoke.');
      return 1;
    }
  }

  const root = mkdtempSync(join(tmpdir(), 'cc-smoke-')); const workspace = join(root, 'workspace');
  try {
    spawnSync('git', ['init', workspace], { stdio: 'ignore' });
    writeFileSync(join(workspace, 'AGENTS.md'), '# Smoke test\nStay within this temporary workspace.\n');
    writeFileSync(join(workspace, 'INPUT.txt'), 'READ_OK\n');
    spawnSync('git', ['-C', workspace, 'add', '.'], { stdio: 'ignore' }); spawnSync('git', ['-C', workspace, '-c', 'user.name=Code Conductor', '-c', 'user.email=smoke@local', 'commit', '-m', 'baseline'], { stdio: 'ignore' });
    const assignment: AgentAssignment = { id: 'SMOKE-A', taskId: 'SMOKE-T', agentId: `smoke-${harness}`, role: mode === 'modify' ? 'builder' : 'reviewer', stance: 'neutral', provider: adapter.provider, harness, surface: adapter.executionSurface, billingChannel: 'subscription', authority: mode === 'modify' ? ['modify_worktree'] : ['review'], dependsOn: [] };
    const task: TaskEnvelope = { id: 'SMOKE-T', objective: mode === 'modify' ? 'Read INPUT.txt, create OUTPUT.txt containing exactly WRITE_OK followed by one newline, and do not touch anything outside this workspace.' : 'Read INPUT.txt and report its exact content without changing any file.', repository: workspace, acceptanceCriteria: [], risk: 'R0', constraints: ['temporary isolated smoke test'], createdAt: new Date().toISOString() };
    const outcome = await adapter.execute({ task, assignment, cwd: workspace, timeoutMs: 180000, prompt: `${task.objective}\nFinal line: CC_RESULT_JSON:{"status":"completed","changes":[],"tests":[],"evidence":[],"findings":[],"risks":[],"blockers":[],"recommendation":"ready"}` });
    const parsed = parseAgentResult(assignment, outcome); const changed = spawnSync('git', ['-C', workspace, 'status', '--porcelain=v1'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).filter(Boolean);
    const writeOk = mode === 'modify' ? (() => { try { return readFileSync(join(workspace, 'OUTPUT.txt'), 'utf8') === 'WRITE_OK\n'; } catch { return false; } })() : changed.length === 0;
    const processOk = adapter.executionSurface === 'acp'
      ? !outcome.timedOut && (outcome.exitCode === null || outcome.exitCode === 0)
      : outcome.exitCode === 0;
    const ok = processOk && parsed.status === 'completed' && writeOk;
    if (!ok) { console.error(`SMOKE FAIL ${harness} ${adapter.executionSurface} ${mode}: exit=${String(outcome.exitCode)} signal=${String(outcome.signal)} timeout=${outcome.timedOut} changed=${changed.join(',') || 'none'}`); return 1; }
    workstation.record(harness, mode, adapter.version(), `Temporary ${mode} smoke passed on ${adapter.executionSurface} without storing credentials.`, adapter.executionSurface);
    console.log(`SMOKE PASS ${harness} ${adapter.executionSurface} ${mode}`); return 0;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function agentsList(args: string[]): number {
  const root = resolve(getOption(args, '--repo') ?? '.');
  const inventory = inventoryNativeCustomizations(root);
  if (args.includes('--json')) { console.log(JSON.stringify(inventory, null, 2)); return 0; }
  console.log(`Provider-native agents and skills (read-only inventory; ADR 0011)\nRepository: ${root}\nAPM lock: ${inventory.lockPresent ? 'present' : 'absent'}`);
  for (const entry of inventory.entries) console.log(`${entry.scope.padEnd(7)} ${entry.kind.padEnd(5)} ${entry.ecosystem.padEnd(12)} ${entry.name.padEnd(36)} ${entry.scope === 'project' ? (inventory.lockPresent ? (entry.managedByApm ? 'apm' : 'unmanaged') : 'no-lock') : 'user'}  ${entry.path}`);
  if (inventory.truncated) console.log('WARN native-inventory.truncated: file budget reached; results are partial.');
  return 0;
}
// JSON keeps the exact argv (for tools that quote per platform) next to this platform's display form.
function presentAction(action: NextAction): Record<string, unknown> {
  return { ...action, ...(action.commands ? { argv: action.commands, commands: action.commands.map((argv) => formatCommand(argv)) } : {}) };
}

function storedManifest(store: RunStore, runId: string): RunManifest {
  const value = store.readManifest(runId);
  assertContract('RunManifest', value);
  return value as RunManifest;
}

function nextCommand(args: string[]): number {
  const store = new RunStore();
  const runId = getOption(args, '--run') ?? store.latestRunId();
  if (!runId) { console.error('No stored runs. Plan or run a task first.'); return 1; }
  try {
    const manifest = storedManifest(store, runId);
    const actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() });
    if (args.includes('--json')) { console.log(JSON.stringify({ runId: manifest.runId, mergeDecision: manifest.mergeDecision, nextActions: actions.map(presentAction) }, null, 2)); return 0; }
    // Everything taken from the run record is untrusted (runs can be imported): each
    // value is printed on one line, so it can neither rewrite the terminal nor forge a
    // step or a command line. Only Code Conductor starts a `$` line, with argv it built
    // and quoted for this platform's shell (nextActions drops commands it cannot show exactly).
    console.log(`Run ${printable(manifest.runId)}: ${manifest.mergeDecision ? `${printable(manifest.mergeDecision.decision)} — ${printable(manifest.mergeDecision.rationale)}` : 'planned (not executed)'}`);
    if (!actions.length) console.log(manifest.mergeDecision ? 'No further step is needed from you for this run.' : 'No next action recorded. Dry-run plans execute nothing; use `cc run --execute` from an interactive terminal.');
    const prompt = DEFAULT_SHELL === 'powershell' ? 'PS>' : '$';
    for (const [index, action] of actions.entries()) {
      // Titles and details mix Code Conductor's text with record values; control and format
      // characters are replaced, and non-ASCII (such as its own separators) is kept readable.
      console.log(`\n${index + 1}. ${printable(action.title, 600, false)} [${action.surface}]\n   ${printable(action.detail, 2000, false)}`);
      if (action.path) console.log(`   path: ${printable(action.path)}`);
      for (const command of action.commands ?? []) console.log(`   ${prompt} ${printable(formatCommand(command), 4000, false)}`);
    }
    return 0;
  } catch (error) { console.error(`ERROR next.unavailable: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}

function handoff(args: string[]): number {
  const runId = getOption(args, '--run'); const assignmentId = getOption(args, '--assignment');
  if (!runId || !assignmentId) { console.error('Usage: cc handoff --run <runId> --assignment <assignmentId>'); return 2; }
  try {
    const manifest = storedManifest(new RunStore(), runId);
    const assignment = manifest.assignments.find((item) => item.id === assignmentId);
    if (!assignment) { console.error(`ERROR handoff.unknown_assignment: ${assignmentId} is not part of ${runId}.`); return 1; }
    // stderr carries guidance; stdout is only the prompt so it can be piped or copied exactly.
    console.error(`Manual handoff for ${printable(assignment.role)} (${printable(assignment.harness)}@${printable(assignment.surface ?? 'manual')}). Paste the prompt below into the official client yourself; this disclosure is your decision. Keep the client's result with run ${printable(runId)}.`);
    const text = assignmentPrompt(manifest.task, assignment);
    if (!process.stdout.isTTY) { process.stdout.write(`${text}\n`); return 0; }
    // On a terminal, untrusted task text must not drive it: each line is shown with
    // control and format characters replaced. Redirect stdout for the exact bytes.
    const shown = terminalText(text);
    console.log(shown.text);
    if (shown.replaced) console.error('Some characters were replaced with "?" for display. Redirect the output (cc handoff … > prompt.txt) to get the exact prompt.');
    return 0;
  } catch (error) { console.error(`ERROR handoff.unavailable: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}

function importRun(args: string[]): number {
  const file = args.find((value) => !value.startsWith('--') && args[args.indexOf(value) - 1] !== '--source');
  if (!file) { console.error('Usage: cc import <run-manifest.json> [--source <label>] [--force]'); return 2; }
  try {
    const outcome = importRunManifest(resolve(file), { source: getOption(args, '--source') ?? 'external', force: args.includes('--force') });
    console.log(JSON.stringify(outcome, null, 2));
    return 0;
  } catch (error) {
    console.error(`ERROR import.rejected: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
function mcpList(args: string[]): number { const root = resolve(getOption(args, '--repo') ?? '.'); const catalog = loadMcpCatalog(root); const profiles = getOption(args, '--profiles')?.split(',').filter(Boolean) ?? detectRepositoryProfiles(root); const allowApi = args.includes('--allow-api'); console.log(JSON.stringify({ profiles, allowSeparatelyBilledApi: allowApi, servers: selectMcpServers(catalog, profiles, allowApi).map(([id, server]) => ({ id, publisher: server.publisher, maturity: server.maturity, authentication: server.authentication, defaultAccess: server.default_access })) }, null, 2)); return 0; }
function apmCheck(rootArg?: string): number { const root = resolve(rootArg ?? '.'); if (!hasCommand('apm')) { console.error('ERROR apm.missing: apm executable is required.'); return 1; } const result = apmAudit(root); process.stdout.write(result.stdout); process.stderr.write(result.stderr); return result.ok ? 0 : 1; }
function githubGate(args: string[]): number { const root = resolve(getOption(args, '--repo') ?? '.'); if (!hasCommand('gh')) { console.error('ERROR github.missing: gh executable is required.'); return 1; } const status = pullRequestStatus(root); process.stdout.write(status.stdout); process.stderr.write(status.stderr); if (!status.ok) return 1; const checks = pullRequestChecks(root); process.stdout.write(checks.stdout); process.stderr.write(checks.stderr); return checks.ok ? 0 : 1; }
function contextStats(): number { const optimizer = new ContextOptimizer(); console.log(JSON.stringify(optimizer.getStats(), null, 2)); return 0; }
function compressFile(args: string[]): number {
  const filePath = args[0];
  if (!filePath) { console.error('ERROR compress.file_required: Specify a file path to prepare as context.'); return 2; }
  const root = resolve(getOption(args, '--root') ?? '.');
  const optimizationMode = args.includes('--aggressive') ? 'aggressive' as const : 'lossless' as const;
  const optimizer = new ContextOptimizer({ allowedRoots: [root] });
  try {
    const { content, result } = optimizer.readCompressedFile(resolve(filePath), 'cli', optimizationMode);
    console.log(`Mode: ${result.mode}\nEstimated original tokens: ${result.originalTokens}\nEstimated optimized tokens: ${result.optimizedTokens}\nEstimated tokens saved: ${result.tokensSaved} (${result.savingsPercent}%)\nOverhead: ${result.overheadMs}ms\nContext ID: ${result.contextId}\n\n--- Prepared Content ---\n${content}`);
    return 0;
  } catch (error) {
    console.error(`ERROR compress.read_failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
function usage(): void { console.log('Usage: cc <validate|workspace-validate|doctor|plan|run|next|handoff|harness-smoke|mcp|agents|import|apm-audit|github-gate|context-stats|compress|version> [options]\n\nplan/run accept optional --specializations <comma,separated,hints>; otherwise routing uses the small inspectable objective-signal map in config/capabilities.yaml.\n\nrun defaults to dry-run; pass --execute only after surface-specific harness smoke passes. --gate-profiles <a,b> chooses deterministic gate profiles for the validator instead of detection (for example terraform-plan, which is never detected). Executing runs ask in this terminal before each consequential action (starting a provider, disclosing context to it, running gate commands, committing) and bind the approval to the exact recipient, revision, content and diff; a non-interactive run cannot approve and those actions fail closed. Modifying worktrees are preserved by default; pass --cleanup-worktrees only to remove clean worktrees after the run.\n\nKiro ACP smoke requires --ack-kiro-policy after reading the current Kiro subscription/automation policy; run read smoke before modify smoke.\n\ncompress <file> defaults to lossless preparation scoped to --root <dir> (default: current directory). Use --aggressive only when comment/whitespace removal is explicitly acceptable.\n\nagents [--repo <dir>] [--json] lists provider-native agents and skills (project and user scope) read-only, marking project files APM did not deploy.\n\nimport <run-manifest.json> [--source <label>] [--force] validates an external RunManifest (for example from Code Workflow) and stores it in the private run store as import-<runId>; manifests carrying a mergeDecision or a ready recommendation are rejected.\n\nnext [--run <runId>] [--json] shows the next native steps for the latest (or given) run: review in Source Control, approve in an interactive terminal, validate a harness, hand off manually, or open a draft PR yourself. Commands are shown, never executed.\n\nhandoff --run <runId> --assignment <id> prints the exact prompt for an assignment you will complete in an official client yourself.'); }

const [command = 'help', ...args] = process.argv.slice(2); let exitCode = 0;
switch (command) {
  case 'workspace-validate': exitCode = validateWorkspace(resolve(args[0] ?? '.')); break;
  case 'validate': exitCode = printValidation(resolve(args[0] ?? '.')); break;
  case 'doctor': exitCode = doctor(resolve(args[0] ?? '.')); break;
  case 'plan': exitCode = plan(args); break;
  case 'run': exitCode = await run(args); break;
  case 'harness-smoke': exitCode = await harnessSmoke(args); break;
  case 'mcp': exitCode = mcpList(args); break;
  case 'agents': exitCode = agentsList(args); break;
  case 'import': exitCode = importRun(args); break;
  case 'next': exitCode = nextCommand(args); break;
  case 'handoff': exitCode = handoff(args); break;
  case 'apm-audit': exitCode = apmCheck(args[0]); break;
  case 'github-gate': exitCode = githubGate(args); break;
  case 'context-stats': exitCode = contextStats(); break;
  case 'compress': exitCode = compressFile(args); break;
  case 'version': case '--version': case '-v': console.log(VERSION); break;
  default: usage(); exitCode = command === 'help' || command === '--help' || command === '-h' ? 0 : 2;
}
process.exitCode = exitCode;
