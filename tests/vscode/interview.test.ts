import { beforeEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ choice: 'Use current answers' as string | undefined, save: 'Save answers', recover: 'Cancel', inputs: [] as (string | undefined)[], documents: [] as string[] }));
vi.mock('vscode', () => ({
  window: { showQuickPick: async () => host.choice, showInputBox: async () => host.inputs.shift(), showTextDocument: async () => {}, showInformationMessage: async () => host.save, showWarningMessage: async () => host.recover },
  workspace: { openTextDocument: async ({ content }: { content: string }) => { host.documents.push(content); return {}; } },
}));
import { runInterview } from '../../apps/vscode/src/interview.js';
beforeEach(() => { host.choice = 'Use current answers'; host.save = 'Save answers'; host.recover = 'Cancel'; host.inputs = []; host.documents = []; });
function storage() {
  const values = new Map<string, string>();
  return { values, context: { secrets: { get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); } } } as any };
}
it('saves private defaults only after preview and reuses them on Redo', async () => {
  const { values, context } = storage();
  await runInterview(context, '/one', () => true);
  expect(values.size).toBe(1); expect(host.documents[0]).toContain('.agent/MEMORY.md');
  const saved = [...values.values()][0]!;
  expect(JSON.parse(saved).origins.mission).toBe('default');
  host.choice = 'Customize'; host.inputs = ['Different mission', undefined];
  await runInterview(context, '/one', () => true);
  expect([...values.values()][0]).toBe(saved);
});
it('does not save on cancel or repository/trust change', async () => {
  const { values, context } = storage();
  host.save = 'Cancel'; await runInterview(context, '/one', () => true);
  expect(values.size).toBe(0);
  host.save = 'Save answers'; await runInterview(context, '/one', () => false);
  expect(values.size).toBe(0);
});
it('isolates confirmed answers between repositories', async () => {
  const { values, context } = storage();
  await runInterview(context, '/one', () => true);
  await runInterview(context, '/two', () => true);
  expect(values.size).toBe(2);
  expect([...values.values()].map((value) => JSON.parse(value).repository)).toEqual(['/one', '/two']);
});
it.each(['{broken', 'null', '{"version":99}'])('can recover invalid private state without deleting it on cancellation: %s', async (broken) => {
  const { values, context } = storage();
  await runInterview(context, '/one', () => true);
  const key = [...values.keys()][0]!; values.set(key, broken);
  await runInterview(context, '/one', () => true);
  expect(values.get(key)).toBe(broken);
  host.recover = 'Start new draft'; host.save = 'Cancel';
  await runInterview(context, '/one', () => true);
  expect(values.get(key)).toBe(broken);
  host.save = 'Save answers';
  await runInterview(context, '/one', () => true);
  expect(JSON.parse(values.get(key)!).version).toBe(1);
});
