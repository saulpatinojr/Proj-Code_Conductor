import { formatCommand, printable, type NextAction } from '@code-conductor/runtime/next-actions';
import { assignmentProgress, displayedDecision, type ProgressEvent } from './run-monitor.js';
import type { RunManifest } from '@code-conductor/schemas';

/** A run id's timestamp (`CC-YYYYMMDDHHMMSS-…`) as `YYYY-MM-DD HH:MM` UTC, or the id itself. */
export function runStartedAt(runId: string): string {
  const match = /^CC-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}-/.exec(runId);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC` : runId;
}

/** A short, single-line form of the objective for a tree label: sanitized, cut at `max` with an ellipsis. */
export function runTitle(manifest: RunManifest, max = 72): string {
  const safe = printable(manifest.task.objective, 10_000, false);
  return safe.length > max ? `${safe.slice(0, max - 1).trimEnd()}…` : safe;
}

/**
 * The run as one Markdown document a person can read in the editor: decision, assignments,
 * gates, next actions, findings, risks and what was not verified. Every line of agent-chosen
 * text goes through `printable`, so run records cannot inject editor-visible control text.
 */
export function runSummaryMarkdown(manifest: RunManifest, actions: readonly NextAction[], events: readonly ProgressEvent[] = []): string {
  const p = (text: string, max = 600): string => printable(text, max, false).replace(/[\\`*_[\]<>|]/g, '\\$&');
  const code = (text: string, max = 600): string => {
    const value = printable(text, max, false);
    const width = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1;
    const fence = '`'.repeat(width);
    return fence + (width > 1 ? ` ${value} ` : value) + fence;
  };
  const decision = manifest.mergeDecision;
  const shownDecision = displayedDecision(manifest, events);
  const progress = assignmentProgress(manifest, events);
  const lines: string[] = [
    `# Run ${p(manifest.runId, 80)}`,
    '',
    `- **Objective:** ${p(manifest.task.objective)}`,
    `- **Risk:** ${p(manifest.task.risk, 8)}${manifest.task.repository ? `  **Repository:** ${code(manifest.task.repository, 300)}` : ''}`,
    `- **Started:** ${runStartedAt(manifest.runId)}`,
    `- **Decision:** ${decision ? `\`${p(shownDecision, 40)}\` — ${p(decision.rationale)}${shownDecision !== decision.decision ? ` (Recorded decision: ${p(decision.decision, 40)}; incomplete or contradictory evidence requires review.)` : ''}` : shownDecision === 'planned' ? '`planned` — nothing was executed' : '`incomplete` — execution observed; no final decision recorded'}`,
    '',
    '## Assignments',
    '',
    '| Role | Agent | Status | Recommendation |',
    '|---|---|---|---|',
  ];
  for (const assignment of manifest.assignments) {
    const result = manifest.results.find((item) => item.assignmentId === assignment.id);
    lines.push(`| ${p(assignment.role, 40)} | ${p(assignment.agentId, 60)} | ${result ? p(result.status, 40) : progress.get(assignment.id)!.state} | ${result ? p(result.recommendation, 40) : ''} |`);
  }
  lines.push('', '## Execution dependencies and observations', '', '| Assignment | Provider / surface | Depends on | Observed state | Authority |', '|---|---|---|---|---|');
  for (const assignment of manifest.assignments) {
    const observation = progress.get(assignment.id)!;
    lines.push(`| ${p(assignment.id, 80)} | ${p(assignment.provider, 60)} / ${p(assignment.surface ?? 'unknown', 40)} | ${assignment.dependsOn.map((id) => p(id, 80)).join(', ') || 'none'} | ${observation.state}${observation.observedAt ? ` (${p(observation.observedAt, 40)})` : ''} | ${assignment.authority.map((item) => p(item, 40)).join(', ')} |`);
  }
  lines.push('', 'States reflect stored results and local journal observations. A start event is not a heartbeat; liveness is unverified. Starts older than five minutes are unknown. Historical approvals never authorize another action.', '');
  if (manifest.gates.length) {
    lines.push('', '## Deterministic gates', '');
    for (const gate of manifest.gates) lines.push(`- ${gate.status === 'passed' ? '✅' : gate.status === 'skipped' ? '⏭️' : '❌'} \`${p(gate.gate, 60)}\` ${p(gate.status, 20)} (${gate.blocking === true ? 'blocking' : gate.blocking === false ? 'advisory' : 'blocking policy unknown'})${gate.summary ? ` — ${p(gate.summary, 300)}` : ''}`);
  }
  if (actions.length) {
    lines.push('', '## Next actions', '');
    for (const action of actions) {
      lines.push(`- **${p(action.title, 200)}** — ${p(action.detail, 600)}`);
      for (const argv of action.commands ?? []) lines.push(`  ${code(formatCommand(argv), 600)}`);
    }
  }
  const evidence = manifest.results.flatMap((result) => result.evidence);
  if (evidence.length) {
    lines.push('', '## Evidence references', '');
    for (const item of evidence) lines.push(`- ${p(item.id, 80)} (${p(item.kind, 30)}): ${p(item.source, 300)} — ${p(item.summary)}${item.sha256 ? `; SHA-256 ${p(item.sha256, 64)}` : ''}`);
  }
  const findings = manifest.results.flatMap((result) => result.findings.map((finding) => ({ role: result.role, finding })));
  if (findings.length) {
    lines.push('', '## Findings', '');
    for (const { role, finding } of findings) lines.push(`- ${finding.blocking ? '🛑' : '•'} **${p(finding.severity, 20)}** (${p(role, 40)}, ${p(finding.id, 40)}): ${p(finding.summary)}`);
  }
  const risks = manifest.results.flatMap((result) => result.risks.map((risk) => `${p(result.role, 40)}: ${p(risk)}`));
  if (risks.length) lines.push('', '## Risks', '', ...risks.map((risk) => `- ${risk}`));
  const blockers = manifest.results.flatMap((result) => result.blockers.map((blocker) => `${p(result.role, 40)}: ${p(blocker)}`));
  if (blockers.length) lines.push('', '## Blockers', '', ...blockers.map((blocker) => `- ${blocker}`));
  const notVerified = manifest.results.flatMap((result) => (result.notVerified ?? []).map((item) => `${p(result.role, 40)}: ${p(item)}`));
  if (notVerified.length) lines.push('', '## Not verified by the agents', '', ...notVerified.map((item) => `- ${item}`));
  if (manifest.worktrees?.length) {
    lines.push('', '## Worktrees', '');
    for (const worktree of manifest.worktrees) lines.push(`- ${code(worktree.branch, 200)} at ${code(worktree.path, 300)} (base ${p(worktree.baseSha, 12)})`);
  }
  if (manifest.approvals?.length) {
    lines.push('', '## Approvals', '');
    for (const approval of manifest.approvals) lines.push(`- ${approval.status === 'approved' ? '✅' : '❌'} ${p(approval.action, 40)} → ${p(approval.recipient ?? '', 120)} (${p(approval.status, 20)})`);
  }
  lines.push('', `_Record: \`~/.code-conductor/runs/${p(manifest.runId, 80)}/manifest.json\`. Read-only; nothing here runs anything._`, '');
  return lines.join('\n');
}
