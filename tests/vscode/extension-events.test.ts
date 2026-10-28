import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({
  folders: [] as any[], commands: new Map<string, (...args: any[]) => any>(), trees: new Map<string, any>(), listeners: new Map<string, (event: any) => any>(), changes: [] as any[],
}));
vi.mock('vscode', () => {
  const disposable = () => ({ dispose() {} });
  const listen = (key: string) => (fn: (event: any) => any) => { host.listeners.set(key, fn); return disposable(); };
  return {
    TreeItem: class { constructor(public label: string) {} }, ThemeIcon: class {}, ThemeColor: class {},
    MarkdownString: class { appendText() {} },
    EventEmitter: class { event = () => disposable(); fire(value: any) { host.changes.push(value); } },
    TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1, None: 0 }, StatusBarAlignment: { Left: 1 },
    TaskScope: { Workspace: 1 }, TaskRevealKind: { Always: 1 }, TaskPanelKind: { Dedicated: 1 },
    Task: class { presentationOptions = {}; constructor(public definition: any) {} }, ProcessExecution: class {}, RelativePattern: class {},
    extensions: { getExtension: () => undefined },
    workspace: {
      isTrusted: true, textDocuments: [], get workspaceFolders() { return host.folders; },
      registerTextDocumentContentProvider: disposable,
      onDidChangeWorkspaceFolders: listen('folders'), onDidGrantWorkspaceTrust: listen('trust'),
      createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: listen('fileCreate'), onDidChange: listen('fileChange'), onDidDelete: listen('fileDelete') }),
    },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      registerTreeDataProvider: (id: string, tree: any) => { host.trees.set(id, tree); return disposable(); },
      showErrorMessage: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn(),
    },
    commands: {
      registerCommand: (name: string, fn: any) => { host.commands.set(name, fn); return disposable(); },
      executeCommand: async (name: string, ...args: any[]) => host.commands.get(name)?.(...args),
    },
    tasks: {
      onDidStartTask: listen('start'), onDidEndTaskProcess: listen('processEnd'), onDidEndTask: listen('end'),
      executeTask: async (task: any) => {
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
import { activate } from '../../apps/vscode/src/extension.js';
let temp: string; let subscriptions: any[] = [];
afterEach(() => {
  for (const item of subscriptions) item.dispose(); subscriptions = [];
  if (temp) rmSync(temp, { recursive: true, force: true });
  host.folders = []; host.commands.clear(); host.trees.clear(); host.listeners.clear(); host.changes = [];
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
  await activate({ subscriptions, extensionPath: extension, workspaceState: { get: () => undefined, update: async () => {} } } as any);
  return { runPath, run };
}
function rows() { return host.trees.get('codeConductor.runs').getChildren().map((item: any) => item.node); }
describe('extension task and evidence events', () => {
  it('retains completion when start/end precede task scheduling resolution', async () => {
    await setup(false);
    await host.commands.get('codeConductor.doctor')!();
    expect(rows().find((row: any) => row.label === 'Last task: succeeded')).toBeDefined();
  });
  it('expires an observed start without polling or subsequent filesystem events', async () => {
    await setup(true);
    expect(rows().find((row: any) => row.contextValue === 'run').children[1].description).toBe('running');
    await vi.advanceTimersByTimeAsync(300001);
    expect(rows().find((row: any) => row.contextValue === 'run').children[1].description).toBe('unknown / stale');
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
