import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { RunStore } from '../../packages/evidence/src/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  trusted: true, remoteName: undefined as string | undefined, dialogs: [] as any[], picks: [] as any[], opened: [] as any[], tasks: [] as any[], folders: [] as any[], commands: new Map<string, (...args: any[]) => any>(), trees: new Map<string, any>(), providers: new Map<string, any>(), documents: new Map<string, any>(), listeners: new Map<string, (event: any) => any>(), changes: [] as any[],
}));
vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  const disposable = () => ({ dispose() {} });
  const listen = (key: string) => (fn: (event: any) => any) => { host.listeners.set(key, fn); return disposable(); };
  return {
    Uri: URI, env: { get remoteName() { return host.remoteName; }, openExternal: async () => false },
    TreeItem: class { constructor(public label: string) {} }, ThemeIcon: class {}, ThemeColor: class {},
    MarkdownString: class { appendText() {} },
    EventEmitter: class { handlers = new Set<(value: any) => void>(); event = (handler: (value: any) => void) => { this.handlers.add(handler); return { dispose: () => this.handlers.delete(handler) }; }; fire(value: any) { host.changes.push(value); for (const handler of this.handlers) handler(value); } },
    TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1, None: 0 }, StatusBarAlignment: { Left: 1 },
    TaskScope: { Workspace: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    Task: class { presentationOptions = {}; constructor(public definition: any) {} }, ProcessExecution: class {}, RelativePattern: class {},
    extensions: { getExtension: () => undefined },
    workspace: {
      get isTrusted() { return host.trusted; }, get textDocuments() { return [...host.documents.values()]; }, get workspaceFolders() { return host.folders; },
      registerTextDocumentContentProvider: (scheme: string, provider: any) => { host.providers.set(scheme, provider); return provider.onDidChange?.((uri: any) => { const doc = host.documents.get(uri.toString()); if (doc) doc.text = provider.provideTextDocumentContent(uri); }) ?? disposable(); },
      openTextDocument: async (uri: any) => {
        host.opened.push(uri); const key = uri.toString();
        if (!host.documents.has(key)) host.documents.set(key, { uri, text: host.providers.get(uri.scheme)?.provideTextDocumentContent(uri) ?? '', getText() { return this.text; } });
        return host.documents.get(key);
      },
      onDidChangeWorkspaceFolders: listen('folders'), onDidGrantWorkspaceTrust: listen('trust'),
      createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: listen('fileCreate'), onDidChange: listen('fileChange'), onDidDelete: listen('fileDelete') }),
    },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerTreeDataProvider: (id: string, tree: any) => { host.trees.set(id, tree); return disposable(); },
      showOpenDialog: async () => host.dialogs.shift(),
      showQuickPick: async (items: any[]) => { const value = host.picks.shift(); return typeof value === 'function' ? value(items) : value === 'first' ? items[0] : value; },
      showTextDocument: async () => {},
      showErrorMessage: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn(),
    },
    commands: {
      registerCommand: (name: string, fn: any) => { host.commands.set(name, fn); return disposable(); },
      executeCommand: async (name: string, ...args: any[]) => host.commands.get(name)?.(...args),
    },
    tasks: {
      onDidStartTask: listen('start'), onDidEndTaskProcess: listen('processEnd'), onDidEndTask: listen('end'),
      executeTask: async (task: any) => {
        host.tasks.push(task);
        // VS Code may clone the Task over RPC. Events can arrive before this promise resolves.
        const execution = { task: { definition: { ...task.definition } } };
        host.listeners.get('start')!({ execution });
        host.listeners.get('processEnd')!({ execution, exitCode: 0 });
        host.listeners.get('end')!({ execution });
        return execution;
      },
    },
  };
});
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn(() => ({ status: 1 })) }));
import * as knowledge from '../../apps/vscode/src/knowledge.js';
import { activate } from '../../apps/vscode/src/extension.js';
let temp: string; let subscriptions: any[] = [];
afterEach(() => {
  for (const item of subscriptions) item.dispose(); subscriptions = [];
  if (temp) rmSync(temp, { recursive: true, force: true });
  host.folders = []; host.commands.clear(); host.trees.clear(); host.providers.clear(); host.documents.clear(); host.listeners.clear(); host.changes = [];
  host.trusted = true; host.remoteName = undefined; host.dialogs = []; host.picks = []; host.opened = []; host.tasks = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs(); vi.useRealTimers();
});
async function setup(withStart: boolean) {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T01:00:00Z'));
  temp = mkdtempSync(join(tmpdir(), 'cc-host-'));
  const repository = join(temp, 'repository'); mkdirSync(repository);
  const extension = join(temp, 'extension'); mkdirSync(join(extension, 'dist'), { recursive: true }); writeFileSync(join(extension, 'dist/ccon.js'), '');
  vi.stubEnv('CODE_CONDUCTOR_HOME', join(temp, 'home'));
  const runId = 'CC-test'; const runPath = join(temp, 'home/runs', runId); mkdirSync(runPath, { recursive: true });
  const run = { runId, task: { id: 'T', objective: 'Test execution overview', repository, acceptanceCriteria: [], risk: 'R1', constraints: [], createdAt: new Date().toISOString() }, assignments: [{ id: 'A', taskId: 'T', agentId: 'builder', role: 'builder', stance: 'constructive', provider: 'openai', harness: 'codex', billingChannel: 'subscription', authority: ['observe'], dependsOn: [] }], results: [], gates: [] };
  writeFileSync(join(runPath, 'manifest.json'), JSON.stringify(run));
  if (withStart) writeFileSync(join(runPath, 'events.jsonl'), JSON.stringify({ runId, assignmentId: 'A', type: 'assignment.started', at: new Date().toISOString() }) + '\n');
  host.folders = [{ uri: { fsPath: repository }, name: 'repository' }];
  const state = new Map<string, unknown>();
  await activate({ subscriptions, extensionPath: extension, workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value); } } } as any);
  return { runPath, run, state };
}
function rows() { return host.trees.get('codeConductor.runs').getChildren().map((item: any) => item.node); }
describe('extension task, evidence and knowledge events', () => {
  it('explains why orchestrator setup cannot start without a selected trusted repository', async () => {
    await setup(false);
    host.trusted = false;
    await host.commands.get('codeConductor.setupOrchestrator')!();
    const vscode = await import('vscode');
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Orchestrator setup requires a trusted workspace.');
    host.trusted = true; host.folders = [];
    await host.commands.get('codeConductor.setupOrchestrator')!();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Select an open repository for orchestrator setup.');
  });

  it('opens only manifest-bound evidence for the selected trusted repository and rechecks on refresh', async () => {
    const { run } = await setup(false);
    const store = new RunStore(join(temp, 'home/runs'));
    const evidenceId = 'E-aaaaaaaa-1111'; const stdout = 'Captured native evidence'; const sha256 = createHash('sha256').update(createHash('sha256').update(stdout).digest()).update(createHash('sha256').update('').digest()).digest('hex');
    const source = 'node test.js (/usr/bin/node)';
    store.saveToolOutput(run.runId, { evidenceId, source, stdout, stderr: '', status: 1, timedOut: false, truncated: false, sha256, digestMethod: 'streams' });
    (run.results as any[]).push({ taskId: 'T', assignmentId: 'A', agentId: 'validator', role: 'validator', stance: 'neutral', provider: 'local', harness: 'internal', billingChannel: 'local', status: 'completed', changes: [], tests: [], evidence: [{ id: evidenceId, kind: 'test', source, summary: 'stored', sha256, uri: 'command:untrusted.never-execute' }], findings: [], risks: [], blockers: [], recommendation: 'changes_required' });
    store.saveManifest(run as any);
    await host.commands.get('codeConductor.refreshRuns')!();
    const row = rows().find((row: any) => row.contextValue === 'run').children.find((row: any) => row.label === 'Stored gate evidence');
    expect(row.children[0].command.arguments).toEqual([run.runId, evidenceId]);
    await host.commands.get('codeConductor.openEvidence')!(run.runId, evidenceId);
    const uri = host.opened.at(-1); expect(uri.scheme).toBe('code-conductor-evidence');
    const provider = host.providers.get(uri.scheme);
    const document = host.documents.get(uri.toString());
    expect(document.getText()).toContain(stdout);
    expect(provider.provideTextDocumentContent(uri)).toContain(stdout);
    expect(provider.provideTextDocumentContent(uri)).not.toContain('untrusted.never-execute');
    host.trusted = false; expect(provider.provideTextDocumentContent(uri)).not.toContain(stdout);
    host.trusted = true; host.folders = []; expect(provider.provideTextDocumentContent(uri)).not.toContain(stdout);
    host.folders = [{ uri: { fsPath: run.task.repository }, name: 'repo' }];
    writeFileSync(join(temp, 'home/runs', run.runId, 'tool-output', `${evidenceId}.stdout`), 'changed');
    await host.commands.get('codeConductor.openEvidence')!(run.runId, evidenceId);
    expect(document.getText()).toContain('cannot be verified');
    store.saveToolOutput(run.runId, { evidenceId, source, stdout, stderr: '', status: 1, timedOut: false, truncated: false, sha256, digestMethod: 'streams' });
    host.listeners.get('fileChange')!({ path: join(temp, 'home/runs', run.runId, 'tool-output', `${evidenceId}.stdout`) });
    await vi.advanceTimersByTimeAsync(151); expect(document.getText()).toContain(stdout);
    const opened = host.opened.length;
    await host.commands.get('codeConductor.openEvidence')!(run.runId, '../manifest'); expect(host.opened).toHaveLength(opened);
  });

  it.skipIf(process.platform !== 'linux')('starts pack preview only after explicit selection and rechecks trust/scope after selection', async () => {
    await setup(false); expect(host.tasks).toHaveLength(0);
    await host.commands.get('codeConductor.previewPacks')!(); expect(host.tasks).toHaveLength(0);
    host.picks = [(items: any[]) => { host.trusted = false; return [items[0]]; }];
    await host.commands.get('codeConductor.previewPacks')!(); expect(host.tasks).toHaveLength(0);
    host.trusted = true;
    host.picks = [(items: any[]) => { host.folders = []; return [items[0]]; }];
    await host.commands.get('codeConductor.previewPacks')!(); expect(host.tasks).toHaveLength(0);
  });
  it.skipIf(process.platform !== 'linux')('launches one preview task for the selected reviewed packs', async () => {
    await setup(false); host.picks = [(items: any[]) => [items[1]]];
    await host.commands.get('codeConductor.previewPacks')!(); expect(host.tasks).toHaveLength(1);
  });
  it('blocks pack preview in Restricted Mode and on remote hosts', async () => {
    await setup(false); host.trusted = false;
    await host.commands.get('codeConductor.previewPacks')!();
    host.trusted = true; host.remoteName = 'ssh-remote';
    await host.commands.get('codeConductor.previewPacks')!(); expect(host.tasks).toHaveLength(0);
  });

  it.skipIf(process.platform !== 'linux')('connects without scanning, falls back to the editor, and disconnects without deleting notes', async () => {
    const scan = vi.spyOn(knowledge, 'indexVault');
    const { run, state } = await setup(false);
    const vault = join(temp, 'vault'); mkdirSync(join(vault, 'project'), { recursive: true });
    const notePath = join(vault, 'project/note.md');
    const text = '---\n' + JSON.stringify({ code_conductor: { version: 1, id: 'note', kind: 'lesson', repository: run.task.repository, sources: [], edges: [] } }) + '\n---\nHuman prose.';
    writeFileSync(notePath, text);
    host.dialogs = [[{ scheme: 'file', fsPath: vault }], [{ scheme: 'file', fsPath: join(vault, 'project') }]];
    expect(scan).not.toHaveBeenCalled();
    await host.commands.get('codeConductor.connectKnowledge')!();
    expect(scan).not.toHaveBeenCalled();
    expect([...state.keys()].some((key) => key.startsWith('codeConductor.knowledge.'))).toBe(true);
    host.picks = ['first', 'Open in Obsidian'];
    await host.commands.get('codeConductor.knowledge')!();
    expect(host.opened[0].fsPath).toBe(notePath);
    await host.commands.get('codeConductor.disconnectKnowledge')!();
    expect([...state.keys()].some((key) => key.startsWith('codeConductor.knowledge.'))).toBe(false);
    expect(readFileSync(notePath, 'utf8')).toBe(text);
  });
  it('does not scan knowledge in Restricted Mode or on remote hosts', async () => {
    const scan = vi.spyOn(knowledge, 'indexVault');
    await setup(false);
    host.trusted = false;
    await host.commands.get('codeConductor.knowledge')!();
    host.trusted = true; host.remoteName = 'ssh-remote';
    await host.commands.get('codeConductor.knowledge')!();
    expect(scan).not.toHaveBeenCalled();
  });
  it('opens recorded plan details through the existing repository-scoped read-only summary', async () => {
    const { run } = await setup(false);
    const plan = rows().find((row: any) => row.contextValue === 'run').children.find((row: any) => row.label === 'Plan details and approval boundaries');
    expect(plan.command).toEqual({ command: 'codeConductor.openRun', title: 'Open run summary', arguments: [run.runId] });
    await host.commands.get(plan.command.command)!(...plan.command.arguments);
    const document = [...host.documents.values()].find((item: any) => item.uri.scheme === 'code-conductor-run');
    expect(document.getText()).toContain('Recorded plan and approval boundaries');
    expect(document.getText()).toContain('Current availability/trust is not established');
    expect(host.tasks).toEqual([]);
  });
  it('retains completion when start/end precede task scheduling resolution', async () => {
    await setup(false);
    await host.commands.get('codeConductor.doctor')!();
    expect(rows().find((row: any) => row.label === 'Last task: succeeded')).toBeDefined();
  });
  it('expires an observed start without polling or subsequent filesystem events', async () => {
    await setup(true);
    expect(rows().find((row: any) => row.contextValue === 'run').children.find((row: any) => row.label.startsWith('builder ·')).description).toBe('running');
    await vi.advanceTimersByTimeAsync(300001);
    expect(rows().find((row: any) => row.contextValue === 'run').children.find((row: any) => row.label.startsWith('builder ·')).description).toBe('unknown / stale');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('excludes foreign, malformed and oversized manifests without crashing the cockpit', async () => {
    const { runPath, run } = await setup(false);
    for (const text of ['{bad', JSON.stringify({ ...run, task: { ...run.task, repository: temp } }), 'x'.repeat(1048577)]) {
      writeFileSync(join(runPath, 'manifest.json'), text);
      await host.commands.get('codeConductor.refreshRuns')!();
      expect(rows().some((row: any) => row.contextValue === 'run')).toBe(false);
    }
  });
  it('coalesces file changes and refreshes from stored evidence', async () => {
    const { runPath, run } = await setup(false);
    run.task.objective = 'Updated objective'; writeFileSync(join(runPath, 'manifest.json'), JSON.stringify(run));
    for (let n = 0; n < 3; n++) host.listeners.get('fileChange')!({ path: join(runPath, 'manifest.json') });
    expect(rows().find((row: any) => row.contextValue === 'run').label).toBe('Test execution overview');
    await vi.advanceTimersByTimeAsync(151);
    expect(rows().find((row: any) => row.contextValue === 'run').label).toBe('Updated objective');
  });
});
