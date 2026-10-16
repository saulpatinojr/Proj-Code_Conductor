import { discoveryInventory } from './discovery.js';
import { loadConfiguration, type ConfigurationName } from '@code-conductor/policy';
import { readBoundedFile } from '@code-conductor/policy/bounded-read';
import { defaultWorktreeRoot } from '@code-conductor/git';
import { nextActions, printable, type NextAction } from '@code-conductor/runtime/next-actions';
import type { RunManifest } from '@code-conductor/schemas';
import { nativeOperation, signInHint } from './native-actions.js';
import * as vscode from 'vscode';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { startupSnapshot, type StartupMode } from './startup.js';
import { cliProcessSpec, localCommandName, missingBaselineCommands } from './execution.js';

type ItemSpec = { label: string; description?: string; tooltip?: string; icon?: string; command?: vscode.Command };
type CapabilitySurface = { kind?: string; identifiers?: string[]; commands?: string[]; command?: string; interactive?: boolean; machine_execution?: boolean; requires_local_client?: boolean; enabled_by_default?: boolean };
type HarnessCapability = { provider?: string; sign_in?: unknown; command_candidates?: string[]; primary_specializations?: string[]; preferred_execution_surface?: string; native_capabilities?: string[]; surfaces?: Record<string, CapabilitySurface> };
type CapabilityDocument = { defaults?: { billing_policy?: string; allow_separately_billed_api?: boolean }; harnesses?: Record<string, HarnessCapability> };
type LocalDiscovery = { version: 3; capturedAt: string; commands: Record<string, boolean>; extensions: Record<string, boolean> };

const STARTUP_FINGERPRINT_KEY = 'codeConductor.startupFingerprint';
const STARTUP_MODE_KEY = 'codeConductor.startupMode';
const STARTUP_DISCOVERY_KEY = 'codeConductor.startupDiscovery';

class ConductorItem extends vscode.TreeItem {
  constructor(spec: ItemSpec) {
    super(spec.label, vscode.TreeItemCollapsibleState.None);
    this.description = spec.description;
    this.tooltip = spec.tooltip;
    this.iconPath = new vscode.ThemeIcon(spec.icon ?? 'circle-outline');
    this.command = spec.command;
  }
}

class ConductorProvider implements vscode.TreeDataProvider<ConductorItem> {
  private readonly changed = new vscode.EventEmitter<ConductorItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly loader: () => ItemSpec[]) {}
  refresh(): void { this.changed.fire(); }
  getTreeItem(element: ConductorItem): vscode.TreeItem { return element; }
  getChildren(): ConductorItem[] { return this.loader().map((item) => new ConductorItem(item)); }
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

function teamItems(root?: string): ItemSpec[] {
  if (!root) return [{ label: 'Open a repository workspace', icon: 'info' }];
  const roles = loadYaml<{ roles?: Record<string, { stance?: string; preferred_harnesses?: string[] }> }>(root, 'config/roles.yaml');
  const capabilities = loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml');
  return Object.entries(roles?.roles ?? {}).map(([role, spec]) => {
    const harnesses = spec.preferred_harnesses ?? [];
    const specializations = [...new Set(harnesses.flatMap((harness) => capabilities?.harnesses?.[harness]?.primary_specializations ?? []))];
    return {
      label: role,
      description: [spec.stance, harnesses.map(harnessLabel).join('/'), specializations.length ? specializations.join(',') : undefined].filter(Boolean).join(' · '),
      tooltip: specializations.length ? `Primary routing specializations: ${specializations.join(', ')}` : undefined,
      icon: role === 'builder' ? 'tools' : role.includes('review') || role.includes('challenger') ? 'search' : 'account',
    };
  });
}

function runsDirectory(): string { return join(process.env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor'), 'runs'); }

/** Bounded, read-only manifest load from the owner-private run store; malformed or oversized manifests are skipped. */
function storedManifest(runId: string): RunManifest | undefined {
  try {
    const value = JSON.parse(readBoundedFile(join(runsDirectory(), runId, 'manifest.json'), 1048576).toString('utf8')) as Partial<RunManifest>;
    return value && typeof value.runId === 'string' && value.task && Array.isArray(value.results) ? value as RunManifest : undefined;
  } catch { return undefined; }
}

function runItems(): ItemSpec[] {
  const runs = runsDirectory();
  if (!existsSync(runs)) return [{ label: 'No runs yet', description: 'Use Code Conductor: Plan Task', icon: 'history' }];
  return readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 20).map((name) => {
    const manifest = storedManifest(name);
    const unavailable = { label: name, description: 'manifest unavailable or too large · use cc next', icon: 'run-all' };
    if (!manifest) return unavailable;
    // One malformed run must not break the whole view.
    let actions: NextAction[];
    try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); } catch { return unavailable; }
    const decision = manifest.mergeDecision?.decision ?? 'planned';
    return {
      label: name,
      description: printable(`${decision}${actions[0] ? ` · next: ${actions[0].title}` : ''}`, 200),
      tooltip: [manifest.task.objective, manifest.mergeDecision?.rationale, ...actions.map((action) => `• ${action.title}`)].filter((line): line is string => Boolean(line)).map((line) => printable(line, 600)).join('\n'),
      icon: decision === 'ready' ? 'pass' : decision === 'planned' ? 'run-all' : decision === 'human_required' ? 'person' : 'warning',
      command: { command: 'codeConductor.nextActions', title: 'Show next actions', arguments: [name] },
    };
  });
}

function gateItems(root?: string): ItemSpec[] {
  if (!root) return [];
  const doc = loadYaml<{ profiles?: Record<string, { gates?: Array<{ id: string; blocking?: boolean }> }> }>(root, 'config/gates.yaml');
  return Object.entries(doc?.profiles ?? {}).flatMap(([profile, spec]) => (spec.gates ?? []).map((gate) => ({ label: gate.id, description: `${profile}${gate.blocking === false ? ' · advisory' : ' · blocking'}`, icon: gate.blocking === false ? 'info' : 'shield' })));
}

function connectionItems(root?: string, discovery?: LocalDiscovery): ItemSpec[] {
  if (!root) return [{ label: 'Open a repository workspace', icon: 'info' }];
  if (!vscode.workspace.isTrusted) return [{ label: 'Restricted Mode', description: 'Local process discovery is disabled', icon: 'lock' }];
  const capabilities = loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml');
  const items: ItemSpec[] = [];
  for (const [id, harness] of Object.entries(capabilities?.harnesses ?? {})) {
    if (id === 'internal-validator') continue;
    const preferredName = harness.preferred_execution_surface ?? 'unknown';
    const preferred = harness.surfaces?.[preferredName];
    const commands = surfaceCommands(harness, preferred);
    const localClientAvailable = commands.some((command) => discovery?.commands[command] === true);
    const extensionIds = Object.values(harness.surfaces ?? {}).flatMap((surface) => surface.identifiers ?? []);
    const extensionAvailable = extensionIds.some((extensionId) => Boolean(vscode.extensions.getExtension(extensionId)));
    const requiresLocal = Boolean(preferred?.requires_local_client);
    const preferredAvailable = requiresLocal ? localClientAvailable : preferred?.kind === 'vscode_extension' ? extensionAvailable : false;
    const allSurfaces = Object.entries(harness.surfaces ?? {}).map(([name, surface]) => `${name}:${surface.kind ?? 'unknown'}${surface.machine_execution ? ':machine' : ':human'}`).join(', ');
    items.push({
      command: { command: 'codeConductor.signIn', title: 'Sign in with the official client', arguments: [id] },
      label: harnessLabel(id),
      description: `${preferredAvailable ? 'detected; auth/trust not checked' : requiresLocal ? 'not detected in cached discovery' : 'native/manual setup not verified'} · preferred ${preferredName}${commands.length ? ` · ${commands.join('|')}` : ''}`,
      tooltip: `Provider: ${harness.provider ?? 'unknown'}\nSign in: ${signInHint(harness.sign_in)?.instructions ?? 'through the official client'}\nSurfaces: ${allSurfaces || 'none'}\nNative capabilities: ${(harness.native_capabilities ?? []).join(', ') || 'none declared'}${extensionIds.length ? `\nVS Code extensions: ${extensionIds.join(', ')}${extensionAvailable ? ' (detected)' : ''}` : ''}`,
      icon: preferredAvailable ? (id === 'kiro' ? 'checklist' : id === 'antigravity' ? 'globe' : id === 'copilot-github' ? 'github' : 'hubot') : 'warning',
    });
  }
  const apmAvailable = discovery?.commands.apm === true;
  items.push({ label: 'Microsoft APM (optional)', description: `${apmAvailable ? 'detected' : 'not detected'} · apm`, icon: apmAvailable ? 'package' : 'warning' });
  return items;
}

function packItems(root?: string): ItemSpec[] {
  if (!root) return [];
  const manifest = loadYaml<{ targets?: string[] }>(root, 'apm.yml');
  const agents = existsSync(join(root, '.apm', 'agents')) ? readdirSync(join(root, '.apm', 'agents')).filter((x) => x.endsWith('.md')).length : 0;
  const skills = existsSync(join(root, '.apm', 'skills')) ? readdirSync(join(root, '.apm', 'skills'), { withFileTypes: true }).filter((x) => x.isDirectory()).length : 0;
  return [
    { label: 'APM lock', description: existsSync(join(root, 'apm.lock.yaml')) ? 'present (Git tracking not checked)' : 'not installed (optional)', icon: existsSync(join(root, 'apm.lock.yaml')) ? 'lock' : 'warning' },
    { label: 'Canonical agents', description: String(agents), icon: 'organization' }, { label: 'Canonical skills', description: String(skills), icon: 'extensions' },
    { label: 'Targets', description: manifest?.targets?.join(', ') ?? 'unknown', icon: 'symbol-array' },
  ];
}

function usageItems(root?: string): ItemSpec[] {
  const capabilities = root ? loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml') : undefined;
  const statsPath = join(process.env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor'), 'context-optimization-stats.json');
  let savedTokens = 0;
  if (existsSync(statsPath)) {
    try {
      const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
      savedTokens = stats.tokensSaved ?? 0;
    } catch { /* ignore */ }
  }
  return [
    { label: 'Billing policy', description: capabilities?.defaults?.billing_policy ?? 'subscription_first', icon: 'credit-card' },
    { label: 'Separately billed API', description: capabilities?.defaults?.allow_separately_billed_api ? 'enabled' : 'disabled by default', icon: capabilities?.defaults?.allow_separately_billed_api ? 'warning' : 'pass' },
    { label: 'Context optimizer', description: 'available · lossless default', tooltip: 'Aggressive comment/whitespace removal is explicit opt-in.', icon: 'zap' },
    { label: 'Estimated input tokens saved', description: `${savedTokens.toLocaleString()} tokens`, tooltip: 'Approximate characters/4 telemetry; not vendor billing data.', icon: 'graph' },
    { label: 'Quota telemetry', description: 'vendor-native / not stored', icon: 'pulse' },
  ];
}

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
  const operation = nativeOperation(action, defaultWorktreeRoot());
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
      const choice = await vscode.window.showInformationMessage(`${printable(action.title, 200)}: copy this command for ${shell}? Run it yourself; Code Conductor does not run it for you.`, { detail: printable(operation.text, 4000, false), modal: true }, 'Copy');
      if (choice === 'Copy') await vscode.env.clipboard.writeText(operation.text);
      return;
    }
    default:
      await vscode.window.showInformationMessage(operation.text);
  }
}

async function showNextActions(context: vscode.ExtensionContext, runId: unknown): Promise<void> {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(runId)) return;
  const manifest = storedManifest(runId);
  if (!manifest) { await vscode.window.showWarningMessage(`Run ${runId} could not be read here. Use \`cc next --run ${runId}\` in a terminal.`); return; }
  let actions: NextAction[];
  try { actions = nextActions(manifest, { worktreeRoot: defaultWorktreeRoot() }); }
  catch { await vscode.window.showWarningMessage(`Run ${runId} could not be read here. Use \`cc next --run ${runId}\` in a terminal.`); return; }
  if (!actions.length) { await vscode.window.showInformationMessage(`${runId}: ${printable(manifest.mergeDecision?.rationale ?? 'Planned only; nothing was executed.', 600)}`); return; }
  const picked = await vscode.window.showQuickPick(actions.map((action) => ({ label: printable(action.title, 200), detail: printable(action.detail, 600), description: action.surface.replace('_', ' '), action })), { placeHolder: `${runId}: ${printable(manifest.mergeDecision?.decision ?? 'planned', 40)}`, matchOnDetail: true });
  if (picked) await performNextAction(context, picked.action);
}

async function showSignIn(root: string | undefined, harnessId: unknown): Promise<void> {
  if (!root || typeof harnessId !== 'string') return;
  const capabilities = loadYaml<CapabilityDocument>(root, 'config/capabilities.yaml');
  const hint = signInHint(capabilities?.harnesses?.[harnessId]?.sign_in);
  if (!hint) { await vscode.window.showInformationMessage(`${harnessLabel(harnessId)}: sign in through its official client.`); return; }
  const choices = [...(hint.command ? ['Copy sign-in command'] : []), ...(hint.docs ? ['Open official documentation'] : [])];
  const choice = await vscode.window.showInformationMessage(`${harnessLabel(harnessId)}: ${hint.instructions} Code Conductor never asks for, stores or copies your credentials.`, ...choices);
  if (choice === 'Copy sign-in command' && hint.command) await vscode.env.clipboard.writeText(hint.command);
  if (choice === 'Open official documentation' && hint.docs) await vscode.env.openExternal(vscode.Uri.parse(hint.docs));
}

async function runCli(context: vscode.ExtensionContext, root: string, args: string[], title: string): Promise<void> {
  const runtime = join(context.extensionPath, 'dist', 'cc.js');
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

  const providers = [
    new ConductorProvider(() => teamItems(root())), new ConductorProvider(runItems), new ConductorProvider(() => gateItems(root())),
    new ConductorProvider(() => connectionItems(root(), context.workspaceState.get<LocalDiscovery>(STARTUP_DISCOVERY_KEY))), new ConductorProvider(() => packItems(root())), new ConductorProvider(() => usageItems(root())),
  ];
  const ids = ['codeConductor.team', 'codeConductor.runs', 'codeConductor.gates', 'codeConductor.connections', 'codeConductor.packs', 'codeConductor.usage'];
  ids.forEach((id, index) => context.subscriptions.push(vscode.window.registerTreeDataProvider(id, providers[index]!)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.refresh', async () => {
    const r = root();
    if (r && vscode.workspace.isTrusted) {
      const discovery = discoverLocalSurfaces();
      await context.workspaceState.update(STARTUP_DISCOVERY_KEY, discovery);
      await context.workspaceState.update(STARTUP_FINGERPRINT_KEY, startupSnapshot(r).fingerprint);
    }
    startupStatus.dispose();
    startupStatus = await initializeStartup(context);
    providers.forEach((provider) => provider.refresh());
  }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void vscode.commands.executeCommand('codeConductor.refresh'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.doctor', async () => { const r = root(); if (r) await runCli(context, r, ['doctor', '.'], 'Code Conductor Doctor'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.validate', async () => { const r = root(); if (r) await runCli(context, r, ['workspace-validate', '.'], 'Code Conductor Validate'); }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.plan', async () => {
    const r = root(); if (!r) return; const objective = await vscode.window.showInputBox({ prompt: 'Task objective', ignoreFocusOut: true }); if (!objective) return;
    const risk = await vscode.window.showQuickPick(['R0', 'R1', 'R2', 'R3', 'R4'], { placeHolder: 'Risk class' }); if (!risk) return;
    await runCli(context, r, ['plan', '--repo', '.', '--risk', risk, '--objective', objective], 'Code Conductor Plan');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.nextActions', async (runId: unknown) => showNextActions(context, runId)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.signIn', async (harnessId: unknown) => showSignIn(root(), harnessId)));
  context.subscriptions.push(vscode.commands.registerCommand('codeConductor.openDecisions', async () => {
    const r = root(); if (!r) return; const uri = vscode.Uri.file(join(r, 'docs', 'DECISIONS.md')); if (existsSync(uri.fsPath)) await vscode.window.showTextDocument(uri);
  }));
}

export function deactivate(): void {}
