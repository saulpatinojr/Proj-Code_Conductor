import { discoveryInventory } from './discovery.js';
import { loadConfiguration, type ConfigurationName } from '@code-conductor/policy';
import { readBoundedFile } from '@code-conductor/policy/bounded-read';
import { defaultWorktreeRoot } from '@code-conductor/git';
import { nextActions, printable, type NextAction } from '@code-conductor/runtime/next-actions';
import type { RunManifest } from '@code-conductor/schemas';
import { nativeOperation, signInHint } from './native-actions.js';
import { runStartedAt, runSummaryMarkdown, runTitle } from './run-summary.js';
import * as vscode from 'vscode';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { startupSnapshot, type StartupMode } from './startup.js';
import { cliProcessSpec, localCommandName, missingBaselineCommands } from './execution.js';

/**
 * One row of a cockpit view. Every row that stands for something a person can act on
 * carries a command: open the file it comes from, open a run's summary, perform a next
 * action, or show the official sign-in guidance. Labels stay short; the whole story is
 * in the tooltip.
 */
type Node = {
  label: string;
  description?: string;
  tooltip?: string | vscode.MarkdownString;
  icon?: string;
  color?: string;
  command?: vscode.Command;
  children?: Node[];
  expanded?: boolean;
  contextValue?: string;
};
type CapabilitySurface = { kind?: string; identifiers?: string[]; commands?: string[]; command?: string; interactive?: boolean; machine_execution?: boolean; requires_local_client?: boolean; enabled_by_default?: boolean };
type HarnessCapability = { provider?: string; sign_in?: unknown; command_candidates?: string[]; primary_specializations?: string[]; preferred_execution_surface?: string; native_capabilities?: string[]; surfaces?: Record<string, CapabilitySurface> };
type CapabilityDocument = { defaults?: { billing_policy?: string; allow_separately_billed_api?: boolean }; harnesses?: Record<string, HarnessCapability> };
type LocalDiscovery = { version: 3; capturedAt: string; commands: Record<string, boolean>; extensions: Record<string, boolean> };

const STARTUP_FINGERPRINT_KEY = 'codeConductor.startupFingerprint';
const STARTUP_MODE_KEY = 'codeConductor.startupMode';
const STARTUP_DISCOVERY_KEY = 'codeConductor.startupDiscovery';
const RUN_SCHEME = 'code-conductor-run';

class ConductorItem extends vscode.TreeItem {
  constructor(readonly node: Node) {
    super(node.label, node.children?.length ? (node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    this.description = node.description;
    this.tooltip = node.tooltip;
    this.iconPath = new vscode.ThemeIcon(node.icon ?? 'circle-outline', node.color ? new vscode.ThemeColor(node.color) : undefined);
    this.command = node.command;
    this.contextValue = node.contextValue;
  }
}

class ConductorProvider implements vscode.TreeDataProvider<ConductorItem> {
  private readonly changed = new vscode.EventEmitter<ConductorItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly loader: () => Node[]) {}
  refresh(): void { this.changed.fire(); }
  getTreeItem(element: ConductorItem): vscode.TreeItem { return element; }
  getChildren(element?: ConductorItem): ConductorItem[] {
    const nodes = element ? element.node.children ?? [] : this.loader();
    return nodes.map((node) => new ConductorItem(node));
  }
}

function workspaceRoot(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
function loadYaml<T>(root: string, path: string): T | undefined {
  if (path.startsWith('config/') && path.endsWith('.yaml')) return loadConfiguration<T>(root, path.slice(7, -5) as ConfigurationName).document;
  try { return parse(readFileSync(join(root, path), 'utf8')) as T; } catch { return undefined; }
}
function commandExists(command: string): boolean {
  if (!vscode.workspace.isTrusted || !localCommandName(command)) return false;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { stdio: 'ignore', shell: false, windowsHide: true, timeout: 2000, killSignal: 'SIGKILL' });
  return result.status === 0 && !result.error && !result.signal;
}
function harnessLabel(id: string): string {
  const labels: Record<string, string> = {
    'copilot-github': 'GitHub Copilot / GitHub',
    claude: 'Claude Code',
    codex: 'OpenAI Codex',
    kiro: 'Kiro',
    antigravity: 'Google Antigravity',
    perplexity: 'Perplexity',
    'internal-validator': 'Code Conductor Validator',
  };
  return labels[id] ?? id;
}
function surfaceCommands(harness: HarnessCapability, surface?: CapabilitySurface): string[] {
  if (surface?.command) return [surface.command];
  if (surface?.commands?.length) return surface.commands;
  return harness.command_candidates ?? [];
}
function markdown(text: string): vscode.MarkdownString {
  const value = new vscode.MarkdownString(text);
  value.isTrusted = false;
  return value;
}
/** Open a file of the workspace (or the packaged default when the workspace has none) in the editor. */
function openFile(root: string | undefined, relative: string, title: string): vscode.Command {
  return { command: 'codeConductor.openFile', title, arguments: [root ? join(root, relative) : undefined, relative] };
}

// ---------------------------------------------------------------- Runs

function runsDirectory(): string { return join(process.env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor'), 'runs'); }

/** Bounded, read-only manifest load from the owner-private run store; malformed or oversized manifests are skipped. */
function storedManifest(runId: string): RunManifest | undefined {
  try {
    const value = JSON.parse(readBoundedFile(join(runsDirectory(), runId, 'manifest.json'), 1048576).toString('utf8')) as Partial<RunManifest>;
    return value && typeof value.runId === 'string' && value.task && Array.isArray(value.results) ? value as RunManifest : undefined;
  } catch { return undefined; }
}

function decisionLook(decision: string): { icon: string; color?: string } {
  switch (decision) {
    case 'ready': return { icon: 'pass-filled', color: 'testing.iconPassed' };
    case 'planned': return { icon: 'circle-large-outline' };
    case 'human_required': return { icon: 'person', color: 'charts.yellow' };
    case 'blocked': return { icon: 'error', color: 'testing.iconFailed' };
    default: return { icon: 'warning', color: 'charts.orange' };
  }
}
function statusLook(status: string): { icon: string; color?: string } {
  switch (status) {
    case 'completed': case 'passed': return { icon: 'pass', color: 'testing.iconPassed' };
    case 'failed': case 'blocked': case 'cancelled': return { icon: 'error', color: 'testing.iconFailed' };
    case 'awaiting_external': return { icon: 'person', color: 'charts.yellow' };
    case 'skipped': return { icon: 'debug-step-over' };
    default: return { icon: 'circle-outline' };
  }
}

function runNode(runId: string): Node {
  const manifest = storedManifest(runId);
  if (!manifest) return { label: runId, description: 'record unavailable', icon: 'warning', tooltip: 'The manifest could not be read here, or is larger than 1 MiB. Use `ccon next --run <id>` in a terminal.' };
  let actions: NextAction[] = [];
  try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); } catch { /* shown without next actions */ }
  const decision = manifest.mergeDecision?.decision ?? 'planned';
  const open: vscode.Command = { command: 'codeConductor.openRun', title: 'Open run summary', arguments: [runId] };
  const children: Node[] = [];
  children.push({
    label: decision === 'planned' ? 'Planned only' : `Decision: ${printable(decision, 40)}`,
    description: printable(manifest.mergeDecision?.rationale ?? 'nothing was executed', 90, false),
    tooltip: printable(manifest.mergeDecision?.rationale ?? 'Planned only; nothing was executed.', 600, false),
    ...decisionLook(decision), command: open,
  });
  for (const assignment of manifest.assignments) {
    const result = manifest.results.find((item) => item.assignmentId === assignment.id);
    const blocking = result?.findings.filter((finding) => finding.blocking).length ?? 0;
    children.push({
      label: `${printable(assignment.role, 40)} · ${harnessLabel(assignment.harness)}`,
      description: result ? `${printable(result.status, 40)} · ${printable(result.recommendation, 40)}${blocking ? ` · ${blocking} blocking` : ''}` : 'not started',
      tooltip: markdown([`**${printable(assignment.agentId, 80)}** (${printable(assignment.stance, 20)}, ${printable(assignment.surface ?? 'surface unknown', 20)})`, ...(result ? [...result.blockers.map((b) => `- ⛔ ${printable(b, 400, false)}`), ...result.findings.map((f) => `- ${f.blocking ? '🛑' : '•'} ${printable(f.severity, 20)}: ${printable(f.summary, 400, false)}`), ...(result.notVerified ?? []).map((n) => `- not verified: ${printable(n, 300, false)}`)] : [])].join('\n')),
      ...statusLook(result?.status ?? 'planned'), command: open,
    });
  }
  for (const gate of manifest.gates) {
    children.push({ label: `gate · ${printable(gate.gate, 60)}`, description: `${printable(gate.status, 20)}${gate.summary ? ` · ${printable(gate.summary, 80, false)}` : ''}`, tooltip: printable(gate.summary ?? gate.status, 600, false), ...statusLook(gate.status), command: open });
  }
  actions.forEach((action, index) => {
    children.push({
      label: printable(action.title, 80, false),
      description: action.surface.replace('_', ' '),
      tooltip: markdown(`${printable(action.detail, 600, false)}${action.commands?.length ? '\n\n' + action.commands.map((argv) => `\`${printable(argv.join(' '), 300, false)}\``).join('\n\n') : ''}`),
      icon: action.surface === 'source_control' ? 'source-control' : action.surface === 'github' ? 'github' : action.surface === 'terminal' ? 'terminal' : 'arrow-right',
      color: 'charts.blue',
      command: { command: 'codeConductor.performAction', title: 'Do this', arguments: [runId, index] },
    });
  });
  return {
    label: runTitle(manifest),
    description: `${printable(decision, 40)} · ${runStartedAt(runId).slice(5, 16)}`,
    tooltip: markdown(`**${printable(runId, 80)}** · risk ${printable(manifest.task.risk, 8)} · ${runStartedAt(runId)}\n\n${printable(manifest.task.objective, 600, false)}\n\n${printable(manifest.mergeDecision?.rationale ?? 'Planned only; nothing was executed.', 600, false)}\n\nClick for the full summary.`),
    ...decisionLook(decision), command: open, children, contextValue: 'run',
  };
}

function runNodes(): Node[] {
  const runs = runsDirectory();
  if (!existsSync(runs)) return [];
  return readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 25).map(runNode);
}

// ---------------------------------------------------------------- Workstation

function clientNodes(root: string, discovery?: LocalDiscovery): Node[] {
  const capabilities = loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml');
  const nodes: Node[] = [];
  for (const [id, harness] of Object.entries(capabilities?.harnesses ?? {})) {
    if (id === 'internal-validator') continue;
    const preferredName = harness.preferred_execution_surface ?? 'unknown';
    const preferred = harness.surfaces?.[preferredName];
    const commands = surfaceCommands(harness, preferred);
    const localClientAvailable = commands.some((command) => discovery?.commands[command] === true);
    const extensionIds = Object.values(harness.surfaces ?? {}).flatMap((surface) => surface.identifiers ?? []);
    const extensionAvailable = extensionIds.some((extensionId) => Boolean(vscode.extensions.getExtension(extensionId)));
    const requiresLocal = Boolean(preferred?.requires_local_client);
    const manual = !requiresLocal && preferred?.kind !== 'vscode_extension';
    const available = requiresLocal ? localClientAvailable : preferred?.kind === 'vscode_extension' ? extensionAvailable : false;
    const hint = signInHint(harness.sign_in);
    nodes.push({
      label: harnessLabel(id),
      description: manual ? 'manual platform' : available ? 'installed' : 'not found',
      tooltip: markdown([
        `**${harnessLabel(id)}** · provider ${printable(harness.provider ?? 'unknown', 40)} · preferred surface \`${printable(preferredName, 40)}\``,
        commands.length ? `Command: \`${commands.join('` or `')}\`` : '',
        extensionIds.length ? `VS Code extension: ${extensionIds.join(', ')}${extensionAvailable ? ' (installed)' : ''}` : '',
        manual ? 'Used through its own platform; nothing to detect locally.' : available ? 'Installed. Whether it is signed in and trusted is what **Doctor** checks.' : 'Not found in the last discovery. Install the official client, then Refresh.',
        hint ? `Sign in: ${printable(hint.instructions, 300, false)}` : '',
        'Click for the official sign-in guidance.',
      ].filter(Boolean).join('\n\n')),
      icon: manual ? 'globe' : available ? 'pass' : 'circle-slash',
      color: manual ? undefined : available ? 'testing.iconPassed' : 'disabledForeground',
      command: { command: 'codeConductor.signIn', title: 'Sign in with the official client', arguments: [id] },
    });
  }
  return nodes;
}

function toolNodes(discovery?: LocalDiscovery): Node[] {
  const tools: Array<[string, string]> = [['node', 'Node.js'], ['git', 'Git'], ['gh', 'GitHub CLI'], ['apm', 'Microsoft APM'], ['terraform', 'Terraform'], ['ansible', 'Ansible'], ['pwsh', 'PowerShell 7'], ['az', 'Azure CLI'], ['aws', 'AWS CLI'], ['gcloud', 'Google Cloud CLI'], ['kubectl', 'kubectl'], ['helm', 'Helm']];
  const required = new Set(['node', 'git', 'gh']);
  return tools.map(([command, label]) => {
    const found = discovery?.commands[command] === true;
    return {
      label, description: `${found ? 'installed' : required.has(command) ? 'missing (required)' : 'not found'} · ${command}`,
      tooltip: found ? `\`${command}\` was found on PATH in the last discovery.` : required.has(command) ? `\`${command}\` is required and was not found. Install it, then Refresh.` : `\`${command}\` is optional; only repositories whose gate profile needs it use it.`,
      icon: found ? 'pass' : required.has(command) ? 'error' : 'circle-slash',
      color: found ? 'testing.iconPassed' : required.has(command) ? 'testing.iconFailed' : 'disabledForeground',
      command: { command: 'codeConductor.doctor', title: 'Run Doctor' },
    };
  });
}

function gateNodes(root: string): Node[] {
  const doc = loadYaml<{ profiles?: Record<string, { gates?: Array<{ id: string; command?: string; args?: string[]; blocking?: boolean }> }> }>(root, 'config/gates.yaml');
  return Object.entries(doc?.profiles ?? {}).map(([profile, spec]) => ({
    label: profile,
    description: `${(spec.gates ?? []).length} gate(s)`,
    icon: 'shield', command: openFile(root, 'config/gates.yaml', 'Open gate catalog'),
    children: (spec.gates ?? []).map((gate) => ({
      label: gate.id,
      description: `${gate.blocking === false ? 'advisory' : 'blocking'}${gate.command ? ` · ${printable([gate.command, ...(gate.args ?? [])].join(' '), 60)}` : ''}`,
      tooltip: gate.blocking === false ? 'Advisory: its result is recorded and never establishes readiness.' : 'Blocking: a failure makes the run changes_required; readiness needs at least one passed blocking gate.',
      icon: gate.blocking === false ? 'info' : 'shield', command: openFile(root, 'config/gates.yaml', 'Open gate catalog'),
    })),
  }));
}

function packNodes(root: string): Node[] {
  const manifest = loadYaml<{ targets?: string[]; dependencies?: { apm?: unknown[] } }>(root, 'apm.yml');
  const lock = existsSync(join(root, 'apm.lock.yaml'));
  const dependencies = Array.isArray(manifest?.dependencies?.apm) ? manifest.dependencies.apm.length : 0;
  const skills = existsSync(join(root, '.apm', 'skills')) ? readdirSync(join(root, '.apm', 'skills'), { withFileTypes: true }).filter((x) => x.isDirectory()).length : 0;
  if (!manifest && !lock) return [{ label: 'No APM packaging', description: 'optional', tooltip: 'This repository declares no agent packs. Code Conductor works without them; packs come from an APM package source such as Agent Packs.', icon: 'package', color: 'disabledForeground' }];
  return [
    { label: 'Pack dependencies', description: String(dependencies), tooltip: 'Packs declared in apm.yml, installed with `apm install` at a pinned reference. Click to open apm.yml.', icon: 'package', command: openFile(root, 'apm.yml', 'Open apm.yml') },
    { label: 'Lock', description: lock ? 'present' : 'missing', tooltip: lock ? 'apm.lock.yaml pins what was installed. Click to open it.' : 'No apm.lock.yaml: run `apm install`.', icon: lock ? 'lock' : 'warning', color: lock ? undefined : 'charts.yellow', ...(lock ? { command: openFile(root, 'apm.lock.yaml', 'Open apm.lock.yaml') } : {}) },
    { label: 'Own skills', description: String(skills), tooltip: 'Skills this repository itself publishes from .apm/skills.', icon: 'extensions', ...(skills ? { command: openFile(root, '.apm/skills', 'Open .apm/skills') } : {}) },
    { label: 'Targets', description: manifest?.targets?.join(', ') ?? 'none', tooltip: 'Clients APM projects the packs into.', icon: 'symbol-array', command: openFile(root, 'apm.yml', 'Open apm.yml') },
  ];
}

function workstationNodes(root: string | undefined, discovery?: LocalDiscovery): Node[] {
  if (!root) return [];
  if (!vscode.workspace.isTrusted) return [{ label: 'Restricted Mode', description: 'trust the workspace to discover clients', icon: 'lock', color: 'charts.yellow', command: { command: 'workbench.trust.manage', title: 'Manage Workspace Trust' } }];
  const clients = clientNodes(root, discovery);
  const tools = toolNodes(discovery);
  const missing = tools.filter((tool) => tool.icon === 'error').length;
  return [
    { label: 'AI clients', description: `${clients.filter((c) => c.icon === 'pass').length} installed`, icon: 'hubot', expanded: true, children: clients, tooltip: 'Installed means found on this machine. Signed in and trusted are checked by Doctor and by the smoke tests.' },
    { label: 'Tools', description: missing ? `${missing} required missing` : `${tools.filter((t) => t.icon === 'pass').length} installed`, icon: 'tools', children: tools, color: missing ? 'testing.iconFailed' : undefined },
    { label: 'Gate profiles', description: `${gateNodes(root).length} profile(s)`, icon: 'shield', children: gateNodes(root), tooltip: 'Deterministic checks the validator runs, chosen by what the repository contains.' },
    { label: 'Packs', description: existsSync(join(root, 'apm.lock.yaml')) ? 'APM' : 'none', icon: 'package', children: packNodes(root) },
  ];
}

// ---------------------------------------------------------------- Policy

function policyNodes(root: string | undefined): Node[] {
  if (!root) return [];
  const roles = loadYaml<{ roles?: Record<string, { stance?: string; preferred_harnesses?: string[]; instructions?: string[] }> }>(root, 'config/roles.yaml');
  const risk = loadYaml<{ risk_classes?: Record<string, { description?: string; required_roles?: string[]; human_approval?: boolean }> }>(root, 'config/risk.yaml');
  const capabilities = loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml');
  const roleNodes: Node[] = Object.entries(roles?.roles ?? {}).map(([role, spec]) => ({
    label: role,
    description: `${spec.stance ?? ''}${spec.preferred_harnesses?.length ? ` · ${spec.preferred_harnesses.map(harnessLabel).join(', ')}` : ''}`,
    tooltip: markdown([`**${role}** (${spec.stance ?? 'stance unset'})`, spec.preferred_harnesses?.length ? `Preferred clients: ${spec.preferred_harnesses.map(harnessLabel).join(', ')}` : '', ...(spec.instructions ?? []).map((rule) => `- ${printable(rule, 300, false)}`)].filter(Boolean).join('\n\n')),
    icon: role === 'builder' ? 'tools' : role === 'validator' ? 'shield' : role.includes('review') || role === 'challenger' || role === 'github_gatekeeper' ? 'search' : role === 'arbiter' || role === 'finalizer' ? 'law' : 'account',
    command: openFile(root, 'config/roles.yaml', 'Open roles'),
  }));
  const riskNodes: Node[] = Object.entries(risk?.risk_classes ?? {}).map(([name, spec]) => ({
    label: name,
    description: `${(spec.required_roles ?? []).join(', ')}${spec.human_approval ? ' · human approval' : ''}`,
    tooltip: printable(spec.description ?? name, 300, false),
    icon: spec.human_approval ? 'person' : 'checklist',
    command: openFile(root, 'config/risk.yaml', 'Open risk classes'),
  }));
  const billingSeparate = Boolean(capabilities?.defaults?.allow_separately_billed_api);
  return [
    { label: 'Roles', description: `${roleNodes.length}`, icon: 'organization', children: roleNodes, tooltip: 'What each role may do, and the rules rendered into its prompt. Click a role to open config/roles.yaml.' },
    { label: 'Risk classes', description: `${riskNodes.length}`, icon: 'checklist', children: riskNodes, tooltip: 'Which roles a run needs, by risk class.' },
    { label: 'Billing', description: billingSeparate ? 'separately billed API allowed' : 'subscriptions only', tooltip: `Policy: ${printable(capabilities?.defaults?.billing_policy ?? 'subscription_first', 40)}. ${billingSeparate ? 'Separately billed API execution is enabled.' : 'Separately billed API execution is disabled; official clients run on their subscriptions.'}`, icon: billingSeparate ? 'warning' : 'credit-card', color: billingSeparate ? 'charts.yellow' : undefined, command: openFile(root, 'config/capabilities.yaml', 'Open capabilities') },
    { label: 'Decisions', description: 'ADRs and the decision register', tooltip: 'docs/DECISIONS.md, when this repository has one.', icon: 'book', command: { command: 'codeConductor.openDecisions', title: 'Open decision register' } },
  ];
}

// ---------------------------------------------------------------- Startup, commands

function discoverLocalSurfaces(): LocalDiscovery {
  if (!vscode.workspace.isTrusted) return { version: 3, capturedAt: new Date().toISOString(), commands: {}, extensions: {} };
  const root = workspaceRoot();
  const inventory = discoveryInventory(root ? loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml') : undefined);
  return {
    version: 3,
    capturedAt: new Date().toISOString(),
    commands: Object.fromEntries(inventory.commands.map((command) => [command, commandExists(command)])),
    extensions: Object.fromEntries(inventory.extensionIds.map((id) => [id, Boolean(vscode.extensions.getExtension(id))])),
  };
}

function startupTooltip(mode: StartupMode, discovery?: LocalDiscovery): string {
  const label = mode === 'first_run' ? 'First-run local discovery completed.' : mode === 'config_changed' ? 'Configuration changed; local discovery refreshed.' : 'Warm start restored from cached local state.';
  if (!discovery) return `${label}\nNo AI provider, ACP session, MCP server, or APM materialization was started.`;
  const available = Object.entries(discovery.commands).filter(([, value]) => value).map(([key]) => key);
  return `${label}\nDetected local commands: ${available.join(', ') || 'none'}\nNo AI provider, ACP session, MCP server, or APM materialization was started.`;
}

async function performNextAction(context: vscode.ExtensionContext, action: NextAction): Promise<void> {
  const operation = nativeOperation(action, defaultWorktreeRoot(), join(context.extensionPath, 'dist', 'ccon.js'));
  switch (operation.type) {
    case 'open_source_control':
      try {
        await vscode.commands.executeCommand('git.openRepository', operation.path);
        await vscode.commands.executeCommand('workbench.view.scm');
      } catch {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(operation.path), { forceNewWindow: true });
      }
      return;
    case 'run_cli': {
      const r = workspaceRoot();
      if (r) await runCli(context, r, operation.args, `Code Conductor ${operation.args[0] ?? ''}`.trim());
      return;
    }
    case 'copy_command': {
      // Shown in a modal (non-modal messages do not show their detail) before anything is
      // copied, so the person sees the exact command they will paste.
      const shell = process.platform === 'win32' ? 'PowerShell' : 'a POSIX shell';
      const choice = await vscode.window.showInformationMessage(`${printable(action.title, 200)}: copy this command for ${shell}? Run it yourself; Code Conductor does not run it for you.`, { detail: operation.text.split('\n').map((line) => printable(line, 2000, false)).join('\n'), modal: true }, 'Copy');
      if (choice === 'Copy') await vscode.env.clipboard.writeText(operation.text);
      return;
    }
    default:
      await vscode.window.showInformationMessage(operation.text);
  }
}

function validRunId(runId: unknown): runId is string { return typeof runId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(runId); }

async function showNextActions(context: vscode.ExtensionContext, runId: unknown): Promise<void> {
  if (!validRunId(runId)) return;
  const manifest = storedManifest(runId);
  if (!manifest) { await vscode.window.showWarningMessage(`Run ${runId} could not be read here. Use \`ccon next --run ${runId}\` in a terminal.`); return; }
  let actions: NextAction[];
  try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); }
  catch { await vscode.window.showWarningMessage(`Run ${runId} could not be read here. Use \`ccon next --run ${runId}\` in a terminal.`); return; }
  if (!actions.length) { await vscode.window.showInformationMessage(`${runId}: ${printable(manifest.mergeDecision?.rationale ?? 'Planned only; nothing was executed.', 600, false)}`); return; }
  const picked = await vscode.window.showQuickPick(actions.map((action) => ({ label: printable(action.title, 200, false), detail: printable(action.detail, 600, false), description: action.surface.replace('_', ' '), action })), { placeHolder: `${runId}: ${printable(manifest.mergeDecision?.decision ?? 'planned', 40)}`, matchOnDetail: true });
  if (picked) await performNextAction(context, picked.action);
}

async function performRunAction(context: vscode.ExtensionContext, runId: unknown, index: unknown): Promise<void> {
  if (!validRunId(runId) || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
  const manifest = storedManifest(runId);
  if (!manifest) return;
  let actions: NextAction[];
  try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); } catch { return; }
  const action = actions[index];
  if (action) await performNextAction(context, action);
}

async function openRunSummary(runId: unknown): Promise<void> {
  if (!validRunId(runId)) return;
  const uri = vscode.Uri.parse(`${RUN_SCHEME}:/${runId}.md`);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true });
  try { await vscode.commands.executeCommand('markdown.showPreview', uri); } catch { /* the Markdown source is open either way */ }
}

/** Run summaries as read-only virtual documents; nothing is written to disk. */
class RunSummaryProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  refresh(): void { /* documents are regenerated on open */ }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const runId = uri.path.replace(/^\//, '').replace(/\.md$/, '');
    if (!validRunId(runId)) return 'Not a run.';
    const manifest = storedManifest(runId);
    if (!manifest) return `Run ${runId} could not be read here. Use \`ccon next --run ${runId}\` in a terminal.`;
    let actions: NextAction[] = [];
    try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); } catch { /* summary without next actions */ }
    return runSummaryMarkdown(manifest, actions);
  }
}

async function showSignIn(root: string | undefined, harnessId: unknown): Promise<void> {
  if (!root || typeof harnessId !== 'string') return;
  const capabilities = loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml');
  const hint = signInHint(capabilities?.harnesses?.[harnessId]?.sign_in);
  if (!hint) { await vscode.window.showInformationMessage(`${harnessLabel(harnessId)}: sign in through its official client.`); return; }
  const choices = [...(hint.command ? ['Copy sign-in command'] : []), ...(hint.docs ? ['Open official documentation'] : []), 'Run Doctor'];
  const choice = await vscode.window.showInformationMessage(`${harnessLabel(harnessId)}: ${hint.instructions} Code Conductor never asks for, stores or copies your credentials.`, ...choices);
  if (choice === 'Copy sign-in command' && hint.command) await vscode.env.clipboard.writeText(hint.command);
  if (choice === 'Open official documentation' && hint.docs) await vscode.env.openExternal(vscode.Uri.parse(hint.docs));
  if (choice === 'Run Doctor') await vscode.commands.executeCommand('codeConductor.doctor');
}

async function openWorkspaceFile(path: unknown, relative: unknown): Promise<void> {
  if (typeof path === 'string' && existsSync(path)) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path)); return; }
  await vscode.window.showInformationMessage(`${typeof relative === 'string' ? relative : 'That file'} is not in this workspace; Code Conductor is using its packaged default.`);
}

async function runCli(context: vscode.ExtensionContext, root: string, args: string[], title: string): Promise<void> {
  const runtime = join(context.extensionPath, 'dist', 'ccon.js');
  if (!existsSync(runtime)) {
    await vscode.window.showErrorMessage('Code Conductor runtime bundle is missing. Reinstall the extension; customer repositories should never build the runtime themselves.');
    return;
  }
  try {
    const spec = cliProcessSpec(root, runtime, args, vscode.workspace.isTrusted);
    const execution = new vscode.ProcessExecution(spec.executable, spec.args, { cwd: spec.cwd });
    const folder = vscode.workspace.workspaceFolders?.find((item) => item.uri.fsPath === root);
    const task = new vscode.Task({ type: 'code-conductor', operation: args[0] ?? 'unknown' }, folder ?? vscode.TaskScope.Workspace, title, 'Code Conductor', execution);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, echo: false };
    await vscode.tasks.executeTask(task);
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Code Conductor command failed to start.');
  }
}

async function initializeStartup(context: vscode.ExtensionContext): Promise<vscode.StatusBarItem> {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 25);
  status.command = 'codeConductor.doctor';
  const root = workspaceRoot();
  if (!root) {
    status.text = '$(radio-tower) Conductor: No Workspace';
    status.tooltip = 'Open a repository workspace to initialize Code Conductor.';
    status.show();
    return status;
  }

  if (!vscode.workspace.isTrusted) {
    status.text = '$(lock) Conductor: Restricted Mode';
    status.tooltip = 'Use VS Code Workspace Trust before local discovery or process execution. Trust does not approve model calls, disclosure, commits or deployments.';
    status.show();
    return status;
  }

  const previous = context.workspaceState.get<string>(STARTUP_FINGERPRINT_KEY);
  const snapshot = startupSnapshot(root, previous);
  let discovery = context.workspaceState.get<LocalDiscovery>(STARTUP_DISCOVERY_KEY);

  if (snapshot.mode !== 'warm' || !discovery || discovery.version !== 3) {
    discovery = discoverLocalSurfaces();
    await context.workspaceState.update(STARTUP_DISCOVERY_KEY, discovery);
  }
  await context.workspaceState.update(STARTUP_FINGERPRINT_KEY, snapshot.fingerprint);
  await context.workspaceState.update(STARTUP_MODE_KEY, snapshot.mode);
  await vscode.commands.executeCommand('setContext', 'codeConductor.startupMode', snapshot.mode);

  const missingRequired = missingBaselineCommands(discovery?.commands ?? {});
  status.text = missingRequired.length ? '$(warning) Conductor: Setup' : '$(check) Conductor Ready';
  status.tooltip = `${startupTooltip(snapshot.mode, discovery)}${missingRequired.length ? `\nMissing baseline commands: ${missingRequired.join(', ')}. Click to run Doctor.` : '\nClick to run Doctor for deeper auth/trust validation.'}`;
  status.show();
  return status;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = () => workspaceRoot();
  let startupStatus = await initializeStartup(context);
  context.subscriptions.push({ dispose: () => startupStatus.dispose() });

  const providers = {
    runs: new ConductorProvider(runNodes),
    workstation: new ConductorProvider(() => workstationNodes(root(), context.workspaceState.get<LocalDiscovery>(STARTUP_DISCOVERY_KEY))),
    policy: new ConductorProvider(() => policyNodes(root())),
  };
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codeConductor.runs', providers.runs),
    vscode.window.registerTreeDataProvider('codeConductor.workstation', providers.workstation),
    vscode.window.registerTreeDataProvider('codeConductor.policy', providers.policy),
    vscode.workspace.registerTextDocumentContentProvider(RUN_SCHEME, new RunSummaryProvider()),
  );
  await vscode.commands.executeCommand('setContext', 'codeConductor.hasRuns', runNodes().length > 0);

  const refreshViews = async (): Promise<void> => {
    Object.values(providers).forEach((provider) => provider.refresh());
    await vscode.commands.executeCommand('setContext', 'codeConductor.hasRuns', runNodes().length > 0);
  };
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.refresh', async () => {
    const r = root();
    if (r && vscode.workspace.isTrusted) {
      const discovery = discoverLocalSurfaces();
      await context.workspaceState.update(STARTUP_DISCOVERY_KEY, discovery);
      await context.workspaceState.update(STARTUP_FINGERPRINT_KEY, startupSnapshot(r).fingerprint);
    }
    startupStatus.dispose();
    startupStatus = await initializeStartup(context);
    await refreshViews();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.refreshRuns', refreshViews));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void vscode.commands.executeCommand('codeConductor.refresh'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.doctor', async () => { const r = root(); if (r) await runCli(context, r, ['doctor', '.'], 'Code Conductor Doctor'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.validate', async () => { const r = root(); if (r) await runCli(context, r, ['workspace-validate', '.'], 'Code Conductor Validate'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.plan', async () => {
    const r = root(); if (!r) return; const objective = await vscode.window.showInputBox({ prompt: 'What should the run do? One sentence; name the files.', placeHolder: 'Add a test for subtract() in math.test.js; do not change math.js', ignoreFocusOut: true }); if (!objective) return;
    const risk = await vscode.window.showQuickPick([
      { label: 'R1', description: 'normal change: builder, reviewer, gates' },
      { label: 'R0', description: 'trivial: builder and gates' },
      { label: 'R2', description: 'important: builder, different-provider challenger, gates, GitHub review' },
      { label: 'R3', description: 'high impact: research, spec, build, challenge, security, gates, GitHub, finalizer, human approval' },
      { label: 'R4', description: 'destructive or production: R3 plus approval before any side effect' },
    ], { placeHolder: 'Risk class' }); if (!risk) return;
    await runCli(context, r, ['plan', '--repo', '.', '--risk', risk.label, '--objective', objective], 'Code Conductor Plan');
    await refreshViews();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.nextActions', async (runId: unknown) => showNextActions(context, runId)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.performAction', async (runId: unknown, index: unknown) => performRunAction(context, runId, index)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.openRun', async (runId: unknown) => openRunSummary(runId)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.openFile', async (path: unknown, relative: unknown) => openWorkspaceFile(path, relative)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.signIn', async (harnessId: unknown) => showSignIn(root(), harnessId)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.openDecisions', async () => {
    const r = root(); if (!r) return; const uri = vscode.Uri.file(join(r, 'docs', 'DECISIONS.md'));
    if (existsSync(uri.fsPath)) await vscode.window.showTextDocument(uri);
    else await vscode.window.showInformationMessage('This repository has no docs/DECISIONS.md. Code Conductor\'s own decision register is at github.com/saulpatinojr/Proj-Code_Conductor/blob/main/docs/DECISIONS.md.');
  }));
}

export function deactivate(): void {}
