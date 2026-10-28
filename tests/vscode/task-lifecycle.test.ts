import { describe, expect, it } from 'vitest';
import { TaskLifecycle } from '../../apps/vscode/src/task-lifecycle.js';

describe('cockpit task lifecycle', () => {
  it('refreshes on completion, ignores foreign tasks and duplicate end events', () => {
    const events: unknown[] = [];
    const tracker = new TaskLifecycle((root, outcome) => events.push([root, outcome]));
    const execution = {};
    tracker.start(execution, '/repo');
    tracker.end({}, 0);
    tracker.end(execution, 0);
    tracker.end(execution, undefined);
    expect(events).toEqual([['/repo', 'running'], ['/repo', 'succeeded']]);
  });
  it('does not show completion while another task in the repository runs', () => {
    const outcomes: string[] = [];
    const tracker = new TaskLifecycle((_root, outcome) => outcomes.push(outcome));
    const first = {}; const second = {};
    tracker.start(first, '/a'); tracker.start(second, '/a');
    tracker.end(first, 0);
    expect(outcomes.at(-1)).toBe('running');
    tracker.end(second, 1);
    expect(outcomes.at(-1)).toBe('failed');
  });
  it('keeps concurrent repository outcomes distinct and never treats cancellation as success', () => {
    const events: unknown[] = [];
    const tracker = new TaskLifecycle((root, outcome) => events.push([root, outcome]));
    const first = {}; const second = {};
    tracker.start(first, '/a'); tracker.start(second, '/b');
    tracker.end(second, 1); tracker.end(first, undefined);
    expect(events).toEqual([['/a', 'running'], ['/b', 'running'], ['/b', 'failed'], ['/a', 'cancelled']]);
  });
});
