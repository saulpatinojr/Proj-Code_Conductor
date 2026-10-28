import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ folders: [] as { uri: { fsPath: string } }[], documents: [] as { uri: { scheme: string; path: string; query: string } }[], fired: [] as unknown[] }));
vi.mock('vscode', () => ({
  TreeItem: class {},
  EventEmitter: class { event = () => {}; fire(value: unknown) { mock.fired.push(value); } },
  workspace: { get workspaceFolders() { return mock.folders; }, get textDocuments() { return mock.documents; }, isTrusted: true },
}));
import { ConfigurationProvider } from '../../apps/vscode/src/extension.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); mock.folders = []; mock.documents = []; mock.fired = []; });
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-config-%-')); roots.push(root);
  mock.folders.push({ uri: { fsPath: root } });
  return root;
}
describe('effective configuration documents', () => {
  it('binds content and provenance to its repository, including percent paths', () => {
    const first = repository(); const second = repository();
    const provider = new ConfigurationProvider();
    for (const root of [first, second]) {
      mkdirSync(join(root, '.code-conductor'));
      writeFileSync(join(root, '.code-conductor/config.json'), JSON.stringify({ version: 1, disabledHarnesses: root === first ? ['codex'] : [] }));
    }
    const a = provider.provideTextDocumentContent({ path: '/capabilities.yaml', query: first } as never);
    const b = provider.provideTextDocumentContent({ path: '/capabilities.yaml', query: second } as never);
    expect(a).toContain(first); expect(b).toContain(second);
    expect(a).not.toMatch(/^  codex:/m); expect(b).toMatch(/^  codex:/m);
    mock.folders = [];
    expect(provider.provideTextDocumentContent({ path: '/roles.yaml', query: first } as never)).toContain('no longer open');
  });
  it('invalidates open configuration documents on refresh, without touching other documents', () => {
    const uri = { scheme: 'code-conductor-config', path: '/roles.yaml', query: repository() };
    mock.documents = [{ uri }, { uri: { ...uri, scheme: 'file' } }];
    new ConfigurationProvider().refresh();
    expect(mock.fired).toEqual([uri]);
  });
});
