import { describe, expect, it } from 'vitest';
import { validateTeamAdvice, type TeamAdvice, type TeamInputs } from '../../packages/runtime/src/orchestration-graph.js';
const inputs: TeamInputs = {
  digest: 'a'.repeat(64),
  agents: [
    { id: 'builder', provider: 'one', capabilities: ['code'], sourceDigest: 'b'.repeat(64), binding: 'manual' },
    { id: 'reviewer', provider: 'two', capabilities: ['review'], sourceDigest: 'c'.repeat(64), binding: 'manual' },
  ],
  roles: [{ id: 'builder', requiredCapabilities: ['code'] }, { id: 'reviewer', requiredCapabilities: ['review'] }],
  requiredRoles: ['builder', 'reviewer'], separateAgents: [['builder', 'reviewer']], separateProviders: [['builder', 'reviewer']], requiredHandoffs: [['reviewer', 'builder']],
};
const advice = (): TeamAdvice => ({ version: 1, inputDigest: inputs.digest, assignments: [
  { id: 'build', agentId: 'builder', role: 'builder', dependsOn: [] },
  { id: 'review', agentId: 'reviewer', role: 'reviewer', dependsOn: ['build'] },
] });
describe('orchestrator advice quality gates', () => {
  it('accepts an explicit manual team without inventing native binding or mutating the proposal', () => {
    const value = advice(); const checked = validateTeamAdvice(value, inputs);
    expect(checked).toEqual(value); checked.assignments[1]!.dependsOn.push('different');
    expect(value.assignments[1]!.dependsOn).toEqual(['build']);
  });
  it('rejects stale input hashes and model authority/file-path additions', () => {
    expect(() => validateTeamAdvice({ ...advice(), inputDigest: 'd'.repeat(64) }, inputs)).toThrow(/stale/);
    expect(() => validateTeamAdvice({ ...advice(), authority: ['approve'] }, inputs)).toThrow(/schema/);
    const value = advice(); Object.assign(value.assignments[0]!, { path: '../AGENTS.md' });
    expect(() => validateTeamAdvice(value, inputs)).toThrow(/assignment/);
  });
  it('rejects unknown, unavailable and incapable agents', () => {
    const value = advice(); value.assignments[0]!.agentId = 'invented';
    expect(() => validateTeamAdvice(value, inputs)).toThrow(/unknown/);
    const absent = structuredClone(inputs); absent.agents[0]!.binding = 'unavailable';
    expect(() => validateTeamAdvice(advice(), absent)).toThrow(/unavailable/);
    const incapable = structuredClone(inputs); incapable.agents[0]!.capabilities = [];
    expect(() => validateTeamAdvice(advice(), incapable)).toThrow(/capability/);
  });
  it('rejects missing required roles, duplicate identities, missing edges and cycles', () => {
    const value = advice(); value.assignments.pop();
    expect(() => validateTeamAdvice(value, inputs)).toThrow(/mandatory/);
    const duplicate = advice(); duplicate.assignments.push({ ...duplicate.assignments[0]! });
    expect(() => validateTeamAdvice(duplicate, inputs)).toThrow(/duplicate/);
    const broken = advice(); broken.assignments[1]!.dependsOn = ['invented'];
    expect(() => validateTeamAdvice(broken, inputs)).toThrow(/recipient/);
    const cyclic = advice(); cyclic.assignments[0]!.dependsOn = ['review'];
    expect(() => validateTeamAdvice(cyclic, inputs)).toThrow(/cyclic/);
    const unordered = advice(); unordered.assignments[1]!.dependsOn = [];
    expect(() => validateTeamAdvice(unordered, inputs)).toThrow(/required handoff/);
  });
  it('preserves policy-required provider independence', () => {
    const same = structuredClone(inputs); same.agents[1]!.provider = same.agents[0]!.provider;
    expect(() => validateTeamAdvice(advice(), same)).toThrow(/separation/);
  });
});
