import { describe, expect, it } from 'vitest';
import { confirmInterview, INTERVIEW_DEFAULTS } from '../../packages/runtime/src/interview.js';
import { proposeBlueprint, BLUEPRINT_BEGIN } from '../../packages/runtime/src/blueprint.js';
import { planBlueprintUpdate } from '../../packages/runtime/src/blueprint-update.js';
import type { TeamInputs } from '../../packages/runtime/src/orchestration-graph.js';

const inputs: TeamInputs = { digest: 'a'.repeat(64), agents: [{ id: 'builder', provider: 'one', capabilities: [], sourceDigest: 'b'.repeat(64), binding: 'manual' }], roles: [{ id: 'builder', requiredCapabilities: [] }], requiredRoles: ['builder'], separateAgents: [], separateProviders: [], requiredHandoffs: [] };
const blueprint = (style = 'Concise.', id = 'build') => proposeBlueprint(confirmInterview('/project', { ...INTERVIEW_DEFAULTS, style }), inputs, { version: 1, inputDigest: inputs.digest, assignments: [{ id, agentId: 'builder', role: 'builder', dependsOn: [] }] });
const actual = (value = blueprint()) => new Map(value.files.map((file) => [file.path, file.content]));

describe('blueprint update preview', () => {
  it('proposes first installation and is idempotent after accepting the exact files', () => {
    const next = blueprint();
    expect(planBlueprintUpdate(next, new Map()).changes).toHaveLength(13);
    expect(planBlueprintUpdate(next, actual(next), next)).toEqual({ status: 'ready-for-preview', changes: [], conflicts: [] });
  });
  it('preserves human memory before and after an accepted managed region on Redo', () => {
    const old = blueprint(); const files = actual(old);
    files.set('.agent/MEMORY.md', 'My decisions\n\n' + files.get('.agent/MEMORY.md')! + '\nLesson: verify results.\n');
    const result = planBlueprintUpdate(blueprint('Show citations.'), files, old);
    expect(result.status).toBe('ready-for-preview');
    const memory = result.changes.find((change) => change.path === '.agent/MEMORY.md')!;
    expect(memory.after).toMatch(/^My decisions\n\n/);
    expect(memory.after).toContain('Show citations.');
    expect(memory.after).toMatch(/Lesson: verify results\.\n$/);
    expect(memory.before).toBe(files.get('.agent/MEMORY.md'));
  });
  it('refuses takeover by markers and refuses partial application when any file conflicts', () => {
    const old = blueprint(); const files = actual(old);
    expect(planBlueprintUpdate(old, files).status).toBe('conflict');
    files.set('.agent/MEMORY.md', files.get('.agent/MEMORY.md')!.replace('Concise.', 'My edit.'));
    const result = planBlueprintUpdate(blueprint('New style.'), files, old);
    expect(result.status).toBe('conflict'); expect(result.changes).toEqual([]);
    expect(result.conflicts.map((item) => item.path)).toContain('.agent/MEMORY.md');
  });
  it('rejects duplicate delimiters, missing accepted files and forged baselines', () => {
    const old = blueprint(); const files = actual(old);
    files.set('.agent/MEMORY.md', files.get('.agent/MEMORY.md')! + BLUEPRINT_BEGIN);
    expect(planBlueprintUpdate(blueprint('New style.'), files, old).status).toBe('conflict');
    files.delete('.agent/MEMORY.md');
    expect(planBlueprintUpdate(old, files, old).status).toBe('conflict');
    expect(() => planBlueprintUpdate(old, files, { ...old, repository: '/other' })).toThrow(/Invalid/);
  });
  it('retires only unchanged accepted handoffs, never human annotations', () => {
    const old = blueprint(); const files = actual(old); const next = blueprint('Concise.', 'replacement');
    const result = planBlueprintUpdate(next, files, old);
    expect(result.changes.find((change) => change.path === '.agent/handoffs/build.md')!.after).toBeNull();
    files.set('.agent/handoffs/build.md', files.get('.agent/handoffs/build.md')! + 'Human annotation\n');
    expect(planBlueprintUpdate(next, files, old).status).toBe('conflict');
  });
});
