import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createTask, planTask } from '../../packages/runtime/src/index.js';

describe('task planner', () => {
  it('builds an R1 team with builder, reviewer, and validator', () => {
    const task = createTask('Implement a safe change', 'R1', resolve('.'));
    const plan = planTask(resolve('.'), task, { availableHarnesses: new Set(['codex', 'claude']) });
    expect(plan.assignments.map((a) => a.role)).toEqual(['builder', 'reviewer', 'validator']);
    expect(plan.assignments.find((a) => a.role === 'builder')?.authority).toContain('modify_worktree');
    expect(plan.assignments.find((a) => a.role === 'builder')?.surface).toBe('cli');
    expect(plan.assignments.find((a) => a.role === 'reviewer')?.authority).not.toContain('modify_worktree');
    expect(plan.assignments.find((a) => a.role === 'validator')?.authority).toContain('execute_validation');
    expect(plan.assignments.find((a) => a.role === 'validator')?.surface).toBe('local');
  });

  it('uses a different provider for the R2 challenger when required by role policy', () => {
    const task = createTask('Change several components', 'R2', resolve('.'));
    const plan = planTask(resolve('.'), task, { availableHarnesses: new Set(['codex', 'claude']) });
    const builder = plan.assignments.find((a) => a.role === 'builder');
    const challenger = plan.assignments.find((a) => a.role === 'challenger');
    expect(builder).toBeDefined();
    expect(challenger).toBeDefined();
    expect(challenger?.provider).not.toBe(builder?.provider);
  });

  it('fails closed when the configured R2 challenger independence constraint cannot be satisfied', () => {
    const task = createTask('Change several components with only one provider available', 'R2', resolve('.'));
    expect(() => planTask(resolve('.'), task, { availableHarnesses: new Set(['codex']) })).toThrow(/No eligible harness is available for role challenger/);
  });

  it('routes AWS implementation work to Kiro ACP when Kiro is available', () => {
    const task = createTask('Implement the AWS landing zone changes', 'R1', resolve('.'));
    const plan = planTask(resolve('.'), task, { availableHarnesses: new Set(['codex', 'claude', 'kiro']) });
    const builder = plan.assignments.find((a) => a.role === 'builder');
    expect(builder?.harness).toBe('kiro');
    expect(builder?.provider).toBe('aws');
    expect(builder?.surface).toBe('acp');
  });

  it('routes GCP work to the Google specialist lane when that local lane is available', () => {
    const task = createTask('Implement the Google Cloud Run service on GCP', 'R1', resolve('.'));
    const plan = planTask(resolve('.'), task, { availableHarnesses: new Set(['codex', 'claude', 'antigravity']) });
    const builder = plan.assignments.find((a) => a.role === 'builder');
    expect(builder?.harness).toBe('antigravity');
    expect(builder?.provider).toBe('google');
    expect(builder?.surface).toBe('ide');
  });

  it('routes large-codebase refactoring to Claude and debugging/testing to Codex', () => {
    const refactor = planTask(resolve('.'), createTask('Refactor this large codebase and legacy migration', 'R1', resolve('.')), { availableHarnesses: new Set(['codex', 'claude', 'kiro']) });
    expect(refactor.assignments.find((a) => a.role === 'builder')?.harness).toBe('claude');

    const debug = planTask(resolve('.'), createTask('Debug the failing tests and fix test failures', 'R1', resolve('.')), { availableHarnesses: new Set(['codex', 'claude', 'kiro']) });
    expect(debug.assignments.find((a) => a.role === 'builder')?.harness).toBe('codex');
  });

  it('lets explicit task specialization override objective-derived routing hints', () => {
    const task = createTask('Review the GCP approach but implement the approved target', 'R1', resolve('.'), ['aws']);
    const plan = planTask(resolve('.'), task, { availableHarnesses: new Set(['codex', 'claude', 'kiro']) });
    expect(plan.assignments.find((a) => a.role === 'builder')?.harness).toBe('kiro');
  });

  it('keeps GitHub and Perplexity on their platform/manual specialist surfaces', () => {
    const r2 = planTask(resolve('.'), createTask('Prepare the pull request and code review', 'R2', resolve('.')), { availableHarnesses: new Set(['codex', 'claude']) });
    const gatekeeper = r2.assignments.find((a) => a.role === 'github_gatekeeper');
    expect(gatekeeper?.harness).toBe('copilot-github');
    expect(gatekeeper?.surface).toBe('platform');

    const r3 = planTask(resolve('.'), createTask('Research current options and then implement the approved change', 'R3', resolve('.')), { availableHarnesses: new Set(['codex', 'claude', 'kiro']) });
    const researcher = r3.assignments.find((a) => a.role === 'researcher');
    expect(researcher?.harness).toBe('perplexity');
    expect(researcher?.surface).toBe('manual');
    expect(researcher?.billingChannel).toBe('manual');
  });

  it('projects finalizer merge recommendation authority without approval or merge authority', () => {
    const task = createTask('Prepare a high-impact change for human review', 'R3', resolve('.'));
    const plan = planTask(resolve('.'), task, { availableHarnesses: new Set(['codex', 'claude', 'kiro']) });
    const finalizer = plan.assignments.find((a) => a.role === 'finalizer');
    expect(finalizer).toBeDefined();
    expect(finalizer?.authority).toContain('recommend_merge');
    expect(finalizer?.authority).not.toContain('approve');
    expect(finalizer?.authority).not.toContain('merge');
  });
});

describe('R0 composition (AGENTS.md section 5)', () => {
  it('gives a trivial task its deterministic check: a builder and the internal validator', () => {
    const task = createTask('Fix a typo', 'R0', resolve('.'));
    const plan = planTask(resolve('.'), task, { availableHarnesses: new Set(['codex', 'claude']) });
    expect(plan.assignments.map((a) => a.role)).toEqual(['builder', 'validator']);
    expect(plan.assignments.find((a) => a.role === 'validator')?.harness).toBe('internal-validator');
  });
});
