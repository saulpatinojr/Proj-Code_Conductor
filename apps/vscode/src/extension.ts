import { assignmentProgress, displayedDecision, nextProgressExpiry, progressEvents, type ProgressEvent } from './run-monitor.js';
import { indexVault, obsidianOpenUri, resolveKnowledgeNote, validateConnection, type VaultConnection } from './knowledge.js';
import { relative } from 'node:path';
import { packInventory, packInventoryText } from './pack-inventory.js';
import { sameRepository } from './run-scope.js';
import { stringify } from 'yaml';
import { TaskLifecycle } from './task-lifecycle.js';
import { discoveryInventory } from './discovery.js';
import { loadConfiguration, type ConfigurationName } from '@code-conductor/policy';
import { readBoundedFile } from '@code-conductor/policy/bounded-read';
import { defaultWorktreeRoot } from '@code-conductor/git';
import { nextActions, printable, type NextAction } from '@code-conductor/runtime/next-actions';
import { validateContract } from '@code-conductor/schemas';
import type { RunManifest } from '@code-conductor/schemas';
import { nativeOperation, signInHint } from './native-actions.js';
import { runStartedAt, runSummaryMarkdown, runTitle } from './run-summary.js';
import * as vscode from 'vscode';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  nextRefreshAt?: number;
};
type CapabilitySurface = { kind?: string; identifiers?: string[]; commands?: string[]; command?: string; interactive?: boolean; machine_execution?: boolean; requires_local_client?: boolean; enabled_by_default?: boolean };
type HarnessCapability = { provider?: string; sign_in?: unknown; command_candidates?: string[]; primary_specializations?: string[]; preferred_execution_surface?: string; native_capabilities?: string[]; surfaces?: Record<string, CapabilitySurface> };
type CapabilityDocument = { defaults?: { billing_policy?: string; allow_separately_billed_api?: boolean }; harnesses?: Record<string, HarnessCapability> };
type LocalDiscovery = { version: 3; capturedAt: string; commands: Record<string, boolean>; extensions: Record<string, boolean> };

const STARTUP_FINGERPRINT_KEY = 'codeConductor.startupFingerprint';
const STARTUP_MODE_KEY = 'codeConductor.startupMode';
const STARTUP_DISCOVERY_KEY = 'codeConductor.startupDiscovery';
const RUN_SCHEME = 'code-conductor-run';
let taskLifecycle: TaskLifecycle<vscode.TaskExecution> | undefined;
const taskOutcomes = new Map<string, string>();
const launchedTasks = new Map<string, string>();

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

let selectedWorkspace: string | undefined;
function workspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0]?.uri.fsPath;
  return folders.find((folder) => folder.uri.fsPath === selectedWorkspace)?.uri.fsPath;
}
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
  const value = new vscode.MarkdownString();
  value.appendText(text);
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
  if (!validRunId(runId)) return undefined;
  try {
    const directory = lstatSync(join(runsDirectory(), runId));
    if (!directory.isDirectory() || directory.isSymbolicLink()) return undefined;
    const value = JSON.parse(readBoundedFile(join(runsDirectory(), runId, 'manifest.json'), 1048576).toString('utf8')) as Partial<RunManifest>;
    return value.runId === runId && validateContract('RunManifest', value).ok ? value as RunManifest : undefined;
  } catch { return undefined; }
}

function storedProgress(runId: string): ProgressEvent[] {
  try { return progressEvents(readBoundedFile(join(runsDirectory(), runId, 'events.jsonl'), 1048576).toString('utf8'), runId); }
  catch { return []; }
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
    case 'running': return { icon: 'sync~spin', color: 'charts.blue' };
    case 'waiting': return { icon: 'watch' };
    case 'unknown': return { icon: 'question', color: 'charts.yellow' };
    case 'awaiting_external': return { icon: 'person', color: 'charts.yellow' };
    case 'skipped': return { icon: 'debug-step-over' };
    default: return { icon: 'circle-outline' };
  }
}

function runNode(runId: string): Node {
  const manifest = storedManifest(runId);
  if (!manifest || !sameRepository(manifest.task.repository, workspaceRoot())) return { label: runId, description: 'record unavailable', icon: 'warning', tooltip: 'The manifest could not be read here, or is larger than 1 MiB. Use `ccon next --run <id>` in a terminal.' };
  let actions: NextAction[] = [];
  try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); } catch { /* shown without next actions */ }
  const events = storedProgress(runId);
  const decision = displayedDecision(manifest, events);
  const progress = assignmentProgress(manifest, events);
  const open: vscode.Command = { command: 'codeConductor.openRun', title: 'Open run summary', arguments: [runId] };
  const children: Node[] = [];
  children.push({
    label: decision === 'planned' ? 'Planned only' : `Decision: ${printable(decision, 40)}`,
    description: printable(manifest.mergeDecision?.rationale ?? (decision === 'planned' ? 'nothing was executed' : 'execution observed; no final decision'), 90, false),
    tooltip: printable(manifest.mergeDecision?.rationale ?? (decision === 'planned' ? 'Planned only; nothing was executed.' : 'Execution observed; no final decision recorded.'), 600, false),
    ...decisionLook(decision), command: open,
  });
  for (const assignment of manifest.assignments) {
    const observation = progress.get(assignment.id)!;
    const result = manifest.results.find((item) => item.assignmentId === assignment.id);
    const blocking = result?.findings.filter((finding) => finding.blocking).length ?? 0;
    children.push({
      label: `${printable(assignment.role, 40)} · ${harnessLabel(assignment.harness)}`,
      description: result ? `${printable(result.status, 40)} · ${printable(result.recommendation, 40)}${blocking ? ` · ${blocking} blocking` : ''}` : observation.state === 'unknown' ? 'unknown / stale' : observation.state,
      tooltip: markdown([`**${printable(assignment.agentId, 80)}** (${printable(assignment.stance, 20)}, ${printable(assignment.surface ?? 'surface unknown', 20)})`, `Depends on: ${assignment.dependsOn.map((id) => printable(id, 80)).join(', ') || 'none'}. Provider: ${printable(assignment.provider, 60)}. Authority: ${assignment.authority.map((item) => printable(item, 40)).join(', ')}.`, ...(observation.observedAt ? [`Last observation: ${observation.observedAt}. A start event is not a heartbeat.`] : []), ...(result ? [...result.blockers.map((b) => `- ⛔ ${printable(b, 400, false)}`), ...result.findings.map((f) => `- ${f.blocking ? '🛑' : '•'} ${printable(f.severity, 20)}: ${printable(f.summary, 400, false)}`), ...(result.notVerified ?? []).map((n) => `- not verified: ${printable(n, 300, false)}`)] : [])].join('\n')),
      ...statusLook(observation.state), command: open,
    });
  }
  for (const gate of manifest.gates) {
    children.push({ label: `gate · ${printable(gate.gate, 60)}`, description: `${printable(gate.status, 20)}${gate.summary ? ` · ${printable(gate.summary, 80, false)}` : ''}`, tooltip: printable(gate.summary ?? gate.status, 600, false), ...statusLook(gate.status), command: open });
  }
  children.push({ label: 'Related knowledge', icon: 'book', tooltip: 'Find manually mapped local notes; no private run content is copied.', command: { command: 'codeConductor.knowledge', title: 'Related knowledge', arguments: [runId] } });
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
    tooltip: markdown(`**${printable(runId, 80)}** · risk ${printable(manifest.task.risk, 8)} · ${runStartedAt(runId)}\n\n${printable(manifest.task.objective, 600, false)}\n\n${printable(manifest.mergeDecision?.rationale ?? (decision === 'planned' ? 'Planned only; nothing was executed.' : 'Execution observed; no final decision recorded.'), 600, false)}\n\nClick for the full summary.`),
    ...decisionLook(decision), command: open, children, contextValue: 'run', nextRefreshAt: nextProgressExpiry(manifest, events),
  };
}

function runNodes(): Node[] {
  const runs = runsDirectory();
  if (!workspaceRoot()) return [{ label: 'Select a repository', icon: 'folder', command: { command: 'codeConductor.selectWorkspace', title: 'Select repository' } }];
  const outcome = taskOutcomes.get(workspaceRoot()!);
  const rows: Node[] = outcome ? [{ label: `Last task: ${outcome}`, icon: outcome === 'running' ? 'sync~spin' : outcome === 'succeeded' ? 'pass' : 'warning', tooltip: 'CLI process outcome; this is not a run readiness decision.' }] : [];
  try {
    const entries = (existsSync(runs) ? readdirSync(runs, { withFileTypes: true }) : []).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    const scanned = entries.slice(0, 1000).map((id) => ({ id, manifest: storedManifest(id) }));
    const unavailable = scanned.filter((item) => !item.manifest?.task.repository).length;
    const scoped = scanned.filter((item) => sameRepository(item.manifest?.task.repository, workspaceRoot())).slice(0, 25).map((item) => runNode(item.id));
    return [...rows, ...scoped,
      ...(unavailable ? [{ label: 'Unassociated or unavailable records', description: String(unavailable), icon: 'info', tooltip: 'Missing repository association, malformed or unreadable local records are excluded. Inspect global records explicitly with the CLI; none are assigned by guessing task text.' }] : []),
      ...(entries.length > 1000 ? [{ label: 'Run scan limited', description: 'latest 1,000 local records', icon: 'info', tooltip: 'Only the newest 1,000 local record directories were scanned. Use CLI run retention/lookup for older records.' }] : []),
    ];
  } catch { return [...rows, { label: 'Run store unavailable', icon: 'warning', tooltip: 'Local run records could not be listed. Check the run-store directory permissions, then Refresh Runs.' }]; }

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
  const inventory = packInventory(root);
  const inspect: vscode.Command = { command: 'codeConductor.inspectPacks', title: 'Inspect pack provenance' };
  if (!inventory.manifestSha256 && !inventory.lockSha256 && !inventory.diagnostics.length) return [{ label: 'No APM packaging', description: 'optional', tooltip: 'Basic handoffs work without APM. Click for packaging requirements.', icon: 'package', command: inspect }];
  let ownSkills: number | undefined;
  try {
    const parent = lstatSync(join(root, '.apm'), { throwIfNoEntry: false });
    if (!parent) ownSkills = 0;
    else if (parent.isDirectory() && !parent.isSymbolicLink()) {
      const folder = lstatSync(join(root, '.apm/skills'), { throwIfNoEntry: false });
      if (!folder) ownSkills = 0;
      else if (folder.isDirectory() && !folder.isSymbolicLink()) ownSkills = readdirSync(join(root, '.apm/skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length;
    }
  } catch { /* unavailable is distinct from zero */ }
  return [
    { label: 'Own skills', description: ownSkills === undefined ? 'unavailable' : String(ownSkills), tooltip: 'Repository-authored skill directories; not an audit or trust claim.', icon: 'extensions', command: inspect },
    ...inventory.packs.map((pack): Node => ({ label: printable(pack.name, 80, false), description: `${pack.state} · ${pack.commit?.slice(0, 12) ?? 'no locked commit'}`, tooltip: `Declared: ${printable(pack.reference, 300, false)}. Lock association only; audit unknown.`, icon: pack.state === 'mismatch' || pack.state === 'unsupported' ? 'warning' : 'package', command: inspect })),
    { label: 'Targets', description: inventory.targets.map((target) => printable(target, 40)).join(', ') || 'none', icon: 'symbol-array', command: openFile(root, 'apm.yml', 'Open apm.yml') },
    { label: 'Preview pack projections', description: 'optional · Codex · Linux', tooltip: 'Select reviewed public packs and compare their staged Codex projections. Downloads happen only on request. Repository files are unchanged; installation is separate.', icon: 'diff', command: { command: 'codeConductor.previewPacks', title: 'Preview pack projections' } },
    { label: 'Audit', description: 'unknown · run explicitly', tooltip: 'Run the existing bounded APM audit in a terminal. Audit does not install packs or authorize providers.', icon: 'shield', command: { command: 'codeConductor.auditPacks', title: 'Audit packs' } },
    ...inventory.diagnostics.map((message): Node => ({ label: 'APM metadata needs attention', tooltip: printable(message, 500, false), icon: 'warning', command: inspect })),
    { label: 'Pack provenance', description: 'read-only', icon: 'info', command: inspect },
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
  if (!manifest || !sameRepository(manifest.task.repository, workspaceRoot())) { await vscode.window.showWarningMessage(`Run ${runId} could not be read here. Use \`ccon next --run ${runId}\` in a terminal.`); return; }
  let actions: NextAction[];
  try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); }
  catch { await vscode.window.showWarningMessage(`Run ${runId} could not be read here. Use \`ccon next --run ${runId}\` in a terminal.`); return; }
  if (!actions.length) { await vscode.window.showInformationMessage(`${runId}: ${printable(manifest.mergeDecision?.rationale ?? 'Planned only; nothing was executed.', 600, false)}`); return; }
  const picked = await vscode.window.showQuickPick(actions.map((action) => ({ label: printable(action.title, 200, false), detail: printable(action.detail, 600, false), description: action.surface.replace('_', ' '), action })), { placeHolder: `${runId}: ${printable(manifest.mergeDecision?.decision ?? 'planned', 40)}`, matchOnDetail: true });
  if (picked && sameRepository(manifest.task.repository, workspaceRoot())) await performNextAction(context, picked.action);
}

async function performRunAction(context: vscode.ExtensionContext, runId: unknown, index: unknown): Promise<void> {
  if (!validRunId(runId) || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
  const manifest = storedManifest(runId);
  if (!manifest || !sameRepository(manifest.task.repository, workspaceRoot())) return;
  let actions: NextAction[];
  try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); } catch { return; }
  const action = actions[index];
  if (action) await performNextAction(context, action);
}

async function openRunSummary(runId: unknown): Promise<void> {
  if (!validRunId(runId)) return;
  if (!sameRepository(storedManifest(runId)?.task.repository, workspaceRoot())) return;
  const uri = vscode.Uri.parse(`${RUN_SCHEME}:/${runId}.md`);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true });
  try { await vscode.commands.executeCommand('markdown.showPreview', uri); } catch { /* the Markdown source is open either way */ }
}

/** Run summaries as read-only virtual documents; nothing is written to disk. */
class RunSummaryProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === RUN_SCHEME) this.changed.fire(document.uri);
    }
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const runId = uri.path.replace(/^\//, '').replace(/\.md$/, '');
    if (!validRunId(runId)) return 'Not a run.';
    const manifest = storedManifest(runId);
    if (!manifest || !sameRepository(manifest.task.repository, workspaceRoot())) return `Run ${runId} could not be read here. Use \`ccon next --run ${runId}\` in a terminal.`;
    let actions: NextAction[] = [];
    try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); } catch { /* summary without next actions */ }
    return runSummaryMarkdown(manifest, actions, storedProgress(runId));
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

export class ConfigurationProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === 'code-conductor-config') this.changed.fire(document.uri);
    }
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const name = uri.path.replace(/^\//, '').replace(/\.yaml$/, '') as ConfigurationName;
    if (!['roles', 'risk', 'capabilities', 'authorities', 'gates', 'mcp-catalog', 'references'].includes(name)) return 'Unsupported configuration.';
    const root = uri.query;
    if (!vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === root)) return 'Repository is no longer open.';
    try {
      const loaded = loadConfiguration(root, name, { workspaceOverrides: vscode.workspace.isTrusted });
      return loaded.sources.map((source) => `# ${source.source}: ${source.path} (SHA-256 ${source.sha256})`).join('\n') + '\n# Effective configuration (read-only)\n' + stringify(loaded.document);
    } catch (error) { return `# Configuration unavailable: ${String(error).replace(/[\r\n]/g, ' ')}`; }
  }
}
async function openWorkspaceFile(path: unknown, relative: unknown): Promise<void> {
  if (typeof relative === 'string' && /^config\/(roles|risk|capabilities|authorities|gates|mcp-catalog|references)\.yaml$/.test(relative)) {
    const uri = vscode.Uri.from({ scheme: 'code-conductor-config', path: `/${relative.slice(7)}`, query: workspaceRoot() ?? '' });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    return;
  }
  if (typeof path === 'string' && existsSync(path)) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path)); return; }
  await vscode.window.showInformationMessage(`${typeof relative === 'string' ? relative : 'That file'} is absent. Check repository setup; optional APM files require explicit installation.`);
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
    const launchId = randomUUID();
    const task = new vscode.Task({ type: 'code-conductor', operation: args[0] ?? 'unknown', launchId }, folder ?? vscode.TaskScope.Workspace, title, 'Code Conductor', execution);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, echo: false };
    launchedTasks.set(launchId, root);
    try { await vscode.tasks.executeTask(task); }
    catch (error) { launchedTasks.delete(launchId); throw error; }
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

class PackInventoryProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === 'code-conductor-packs') this.changed.fire(document.uri);
    }
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    if (!vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === uri.query)) return 'Repository is no longer open.';
    return packInventoryText(uri.query);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = () => workspaceRoot();
  const knowledgeKey = (r: string): string => `codeConductor.knowledge.${encodeURIComponent(r)}`;
  const connectionFor = (r: string | undefined): VaultConnection | undefined => r ? context.workspaceState.get<VaultConnection>(knowledgeKey(r)) : undefined;
  const knowledgeAvailable = (): boolean => vscode.workspace.isTrusted && !vscode.env.remoteName && process.platform === 'linux';

  let startupStatus = await initializeStartup(context);
  context.subscriptions.push({ dispose: () => startupStatus.dispose() });

  const summaries = new RunSummaryProvider();
  const configurations = new ConfigurationProvider();
  let runRows = runNodes();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const packs = new PackInventoryProvider();
  const providers = {
    runs: new ConductorProvider(() => runRows),
    workstation: new ConductorProvider(() => [...workstationNodes(root(), context.workspaceState.get<LocalDiscovery>(STARTUP_DISCOVERY_KEY)), { label: 'Knowledge', description: connectionFor(root()) ? 'connected · on demand' : 'optional · not connected', icon: 'book', tooltip: 'Explicitly connect an existing local vault folder. No scan or note write at startup.', command: { command: 'codeConductor.knowledge', title: 'Browse related knowledge' } }]),
    policy: new ConductorProvider(() => policyNodes(root())),
  };
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codeConductor.runs', providers.runs),
    vscode.window.registerTreeDataProvider('codeConductor.workstation', providers.workstation),
    vscode.window.registerTreeDataProvider('codeConductor.policy', providers.policy),
    vscode.workspace.registerTextDocumentContentProvider(RUN_SCHEME, summaries),
    vscode.workspace.registerTextDocumentContentProvider('code-conductor-packs', packs),
    vscode.workspace.registerTextDocumentContentProvider('code-conductor-config', configurations),
  );
  await vscode.commands.executeCommand('setContext', 'codeConductor.hasRuns', runRows.some((node) => node.contextValue === 'run'));

  const refreshViews = async (): Promise<void> => {
    runRows = runNodes();
    if (expiryTimer) clearTimeout(expiryTimer);
    const expiries = runRows.flatMap((node) => node.nextRefreshAt === undefined ? [] : [node.nextRefreshAt]);
    expiryTimer = expiries.length ? setTimeout(() => { expiryTimer = undefined; void refreshViews(); }, Math.max(1, Math.min(...expiries) - Date.now() + 1)) : undefined;
    summaries.refresh();
    configurations.refresh();
    packs.refresh();
    Object.values(providers).forEach((provider) => provider.refresh());
    await vscode.commands.executeCommand('setContext', 'codeConductor.hasRuns', runRows.some((node) => node.contextValue === 'run'));
  };
  await refreshViews();
  context.subscriptions.push({ dispose: () => { if (expiryTimer) clearTimeout(expiryTimer); } });
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRunRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void refreshViews(); }, 150);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(runsDirectory(), '*/*'));
  const changedRunFile = (uri: vscode.Uri): void => {
    if (/\/(manifest\.json|events\.jsonl)$/.test(uri.path)) scheduleRunRefresh();
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(changedRunFile), watcher.onDidChange(changedRunFile), watcher.onDidDelete(changedRunFile), { dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } });
  taskLifecycle = new TaskLifecycle((taskRoot, outcome) => {
    taskOutcomes.set(taskRoot, outcome);
    void refreshViews();
    if (outcome === 'failed') void vscode.window.showWarningMessage('Code Conductor task failed. See its terminal output for diagnostics.');
    if (outcome === 'cancelled') void vscode.window.showInformationMessage('Code Conductor task ended without an exit status; completion is unverified.');
  });
  context.subscriptions.push(
    vscode.tasks.onDidStartTask((event) => {
      const launchId: unknown = event.execution.task.definition.launchId;
      if (typeof launchId !== 'string') return;
      const taskRoot = launchedTasks.get(launchId);
      launchedTasks.delete(launchId);
      if (taskRoot) taskLifecycle?.start(event.execution, taskRoot);
    }),
    vscode.tasks.onDidEndTaskProcess((event) => taskLifecycle?.end(event.execution, event.exitCode)),
    vscode.tasks.onDidEndTask((event) => taskLifecycle?.end(event.execution, undefined)),
    { dispose: () => { taskLifecycle = undefined; } },
  );
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
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.selectWorkspace', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const picked = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath })), { placeHolder: 'Select the repository for Code Conductor' });
    if (!picked) return;
    selectedWorkspace = picked.description;
    await vscode.commands.executeCommand('codeConductor.refresh');
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void vscode.commands.executeCommand('codeConductor.refresh'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.refreshRuns', refreshViews));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void vscode.commands.executeCommand('codeConductor.refresh'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.connectKnowledge', async () => {
    const r = root(); if (!r) return;
    if (!knowledgeAvailable()) { await vscode.window.showWarningMessage('Knowledge indexing requires a trusted local Linux workspace with descriptor-safe reads. Windows, macOS and remote hosts remain unsupported for indexing.'); return; }
    const vault = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select existing Obsidian vault' });
    if (!vault?.[0] || vault[0].scheme !== 'file' || r !== root()) return;
    const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vault[0], openLabel: 'Select allowed folder inside vault' });
    if (!folder?.[0] || folder[0].scheme !== 'file' || r !== root() || !knowledgeAvailable()) return;
    try {
      const connection = validateConnection({ vault: vault[0].fsPath, folder: relative(vault[0].fsPath, folder[0].fsPath).split('\\').join('/'), repository: r });
      await context.workspaceState.update(knowledgeKey(r), connection);
      await refreshViews();
      await vscode.window.showInformationMessage('Knowledge connected. Browse to index explicitly. No notes were created or uploaded.');
    } catch { await vscode.window.showWarningMessage('Knowledge connection refused. Select an existing non-symlink vault and a contained non-hidden folder.'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.disconnectKnowledge', async () => {
    const r = root(); if (!r) return;
    await context.workspaceState.update(knowledgeKey(r), undefined);
    await refreshViews();
    await vscode.window.showInformationMessage('Knowledge disconnected. No notes were deleted.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.knowledge', async (runId: unknown) => {
    const r = root(); if (!r) return;
    if (!knowledgeAvailable()) { await vscode.window.showWarningMessage('Knowledge indexing requires a trusted local Linux workspace; remote/Windows/macOS indexing remains unsupported.'); return; }
    const connection = connectionFor(r);
    if (!connection) { await vscode.commands.executeCommand('codeConductor.connectKnowledge'); return; }
    if (!sameRepository(connection.repository, r)) return;
    if (runId !== undefined && (!validRunId(runId) || !sameRepository(storedManifest(runId)?.task.repository, r))) return;
    try {
      const index = indexVault(connection);
      const notes = runId === undefined ? index.notes : index.notes.filter((note) => note.sources.some((source) => source.kind === 'run' && source.id === runId));
      if (!notes.length) { await vscode.window.showInformationMessage(`No matching knowledge notes. ${index.limited ? 'Scan limit reached; narrow the folder.' : 'Only valid metadata for the selected repository is indexed.'} ${index.diagnostics.length} excluded/unavailable items.`); return; }
      const selected = await vscode.window.showQuickPick(notes.map((note) => ({ label: printable(note.title, 100, false), description: `${note.kind} · ${note.sources.map((source) => source.state).join(', ') || 'no verified source'}`, detail: `${note.id}: ${note.edges.map((edge) => `${edge.kind} ${edge.target} (source ${edge.state})`).join('; ') || 'No declared edges'}`, note })), { placeHolder: `Local knowledge: ${notes.length} notes; ${index.diagnostics.length} excluded/unavailable items${index.limited ? ' · scan limited' : ''}`, matchOnDetail: true });
      if (!selected) return;
      const action = await vscode.window.showQuickPick(['Open in editor', 'Open in Obsidian'], { placeHolder: 'Knowledge is navigation; it grants no execution authority.' });
      if (!action || r !== root() || !knowledgeAvailable() || JSON.stringify(connectionFor(r)) !== JSON.stringify(connection)) return;
      const path = resolveKnowledgeNote(connection, selected.note);
      if (action === 'Open in Obsidian') {
        try { if (await vscode.env.openExternal(vscode.Uri.parse(obsidianOpenUri(path)))) return; }
        catch { /* Unsupported URI characters or absent client fall back to the editor. */ }
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch { await vscode.window.showWarningMessage('Knowledge is unavailable or changed. Reconnect/refresh the selected folder. No note was changed or uploaded.'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.inspectPacks', async () => {
    const r = root(); if (!r) return;
    const uri = vscode.Uri.from({ scheme: 'code-conductor-packs', path: '/inventory.txt', query: r });
    const document = await vscode.workspace.openTextDocument(uri);
    packs.refresh();
    // Regenerate a new snapshot on each request; never claim an old audit or live state.
    await vscode.window.showTextDocument(document, { preview: true });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.previewPacks', async () => {
    const r = root(); if (!r) return;
    if (!vscode.workspace.isTrusted || vscode.env.remoteName || process.platform !== 'linux') { await vscode.window.showWarningMessage('Pack preview requires a trusted local Linux workspace, APM 0.33.0 and bubblewrap.'); return; }
    const selected = await vscode.window.showQuickPick([
      { label: 'TypeScript distinguished engineer', pack: 'typescript-distinguished-engineer-pack', description: 'Reviewed mirror · 16f41836d65c · Codex projections' },
      { label: 'GitHub expert engineer', pack: 'github-expert-engineer-pack', description: 'Reviewed mirror · 16f41836d65c · Codex projections' },
    ], { canPickMany: true, title: 'Preview public pack downloads; repository files stay unchanged', ignoreFocusOut: true });
    if (!selected?.length || !sameRepository(root(), r) || !vscode.workspace.isTrusted || vscode.env.remoteName) return;
    await runCli(context, r, ['apm-preview', '--repo', r, '--packs', selected.map((item) => item.pack).join(',')], 'Code Conductor Pack Projection Preview');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.auditPacks', async () => {
    const r = root(); if (r) await runCli(context, r, ['apm-audit', '.'], 'Code Conductor APM Audit');
  }));
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
    if (r !== root()) { await vscode.window.showWarningMessage('Repository selection changed. Start planning again for the selected repository.'); return; }
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
