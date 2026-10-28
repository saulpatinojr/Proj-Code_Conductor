import type { RunManifest } from '@code-conductor/schemas';

export interface ProgressEvent { runId: string; at: string; type: 'assignment.started' | 'assignment.completed' | 'validation.completed' | 'run.completed'; assignmentId?: string }
export type AssignmentState = 'planned' | 'waiting' | 'running' | 'unknown' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'awaiting_external';

/** Journal input is bounded by the caller. Incomplete appended lines are ignored. */
export function progressEvents(text: string, runId: string): ProgressEvent[] {
  const lines = text.split('\n');
  lines.pop();
  const events: ProgressEvent[] = [];
  for (const line of lines.slice(-2000)) {
    try {
      const event = JSON.parse(line) as ProgressEvent;
      if (event.runId !== runId || !['assignment.started', 'assignment.completed', 'validation.completed', 'run.completed'].includes(event.type) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) continue;
      if (event.type !== 'run.completed' && typeof event.assignmentId !== 'string') continue;
      events.push(event);
    } catch { /* malformed journal lines cannot establish state */ }
  }
  return events;
}

/** Results are authoritative; an old start event is an observation, not proof of liveness. */
export function assignmentProgress(manifest: RunManifest, events: readonly ProgressEvent[], now = Date.now()): Map<string, { state: AssignmentState; observedAt?: string }> {
  const states = new Map<string, { state: AssignmentState; observedAt?: string }>();
  for (const assignment of manifest.assignments) {
    const result = manifest.results.find((item) => item.assignmentId === assignment.id);
    const last = [...events].reverse().find((event) => event.assignmentId === assignment.id);
    if (result) { states.set(assignment.id, { state: result.status, ...(last ? { observedAt: last.at } : {}) }); continue; }
    if (last) {
      const age = now - Date.parse(last.at);
      states.set(assignment.id, { state: last.type === 'assignment.started' && age >= 0 && age < 300000 && !manifest.mergeDecision ? 'running' : 'unknown', observedAt: last.at });
      continue;
    }
    const waiting = assignment.dependsOn.some((id) => !manifest.results.some((item) => item.assignmentId === id && item.status === 'completed'));
    states.set(assignment.id, { state: manifest.mergeDecision ? 'unknown' : waiting ? 'waiting' : 'planned' });
  }
  return states;
}

/** Never turn contradictory stored evidence into a green cockpit label. */
export function displayedDecision(manifest: RunManifest, events: readonly ProgressEvent[] = []): string {
  const recorded = manifest.mergeDecision?.decision;
  if (!recorded) return manifest.results.length || events.some((event) => event.type === 'assignment.started') ? 'incomplete' : 'planned';
  if (recorded !== 'ready') return recorded;
  if (['R3', 'R4'].includes(manifest.task.risk)) return 'human_required';
  if (manifest.approvals?.some((item) => item.status !== 'approved')) return 'human_required';
  if (!manifest.assignments.length || manifest.assignments.some((assignment) => !manifest.results.some((item) => item.assignmentId === assignment.id && item.status === 'completed')) || manifest.results.some((item) => item.recommendation === 'human_required')) return 'human_required';
  if (manifest.results.some((item) => item.recommendation === 'changes_required')) return 'changes_required';
  if (manifest.results.some((item) => item.findings.some((finding) => finding.blocking)) || !manifest.gates.some((gate) => gate.status === 'passed')) return 'changes_required';
  return 'ready';
}

/** Earliest future staleness transition, for one-shot invalidation without polling. */
export function nextProgressExpiry(manifest: RunManifest, events: readonly ProgressEvent[], now = Date.now()): number | undefined {
  const candidates = [...assignmentProgress(manifest, events, now).values()]
    .filter((item) => item.state === 'running' && item.observedAt)
    .map((item) => Date.parse(item.observedAt!) + 300000);
  return candidates.length ? Math.min(...candidates) : undefined;
}
