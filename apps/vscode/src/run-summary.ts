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
  const snapshot = manifest.planReview;
  const lines: string[] = [
    `# Run ${p(manifest.runId, 80)}`,
    '',
    `- **Objective:** ${p(manifest.task.objective)}`,
    `- **Risk:** ${p(manifest.task.risk, 8)}${manifest.task.repository ? `  **Repository:** ${code(manifest.task.repository, 300)}` : ''}`,
    `- **Started:** ${runStartedAt(manifest.runId)}`,
    `- **Decision:** ${decision ? `\`${p(shownDecision, 40)}\` — ${p(decision.rationale)}${shownDecision !== decision.decision ? ` (Recorded decision: ${p(decision.decision, 40)}; incomplete or contradictory evidence requires review.)` : ''}` : shownDecision === 'planned' ? '`planned` — nothing was executed' : '`incomplete` — execution observed; no final decision recorded'}`,
    '',
    '## Recorded plan and approval boundaries',
    '',
    `- **Requested specializations:** ${manifest.task.specializations?.length ? manifest.task.specializations.map((value) => p(value, 100)).join(', ') : snapshot ? 'none explicitly supplied' : 'not recorded; objective-inferred routing specializations were not persisted'}`,
    ...(snapshot ? [`- **Planning snapshot:** version ${snapshot.version}, captured ${p(snapshot.capturedAt, 40)}. Historical observations only; the validation worktree is re-planned before fresh execution approval.`, `- **Routing specializations:** ${snapshot.specializations.values.map((value) => p(value, 100)).join(', ') || 'none'} (source: ${p(snapshot.specializations.source, 30)}).`] : []),
    `- **Planned gate commands:** ${snapshot?.checks.state === 'recorded' ? `${snapshot.checks.gates.length} recorded (${p(snapshot.checks.selection, 20)} profiles); see the bounded command preview below.` : 'not recorded in this manifest. The runtime resolves the exact command plan and prerequisites in the validation worktree before asking for execution approval; recorded gate results below describe outcomes, not a future command plan.'}`,
    '- **Provider readiness:** the plan records a chosen provider/surface, not an authentication, billing-account or workstation-trust snapshot. Recorded results below are historical outcomes; current availability, sign-in, health and trust remain unknown here. Use Doctor and the official client for current checks.',
    '- **Required approvals:** D-059 requires a fresh, exact-context decision immediately before each consequential action. Workspace Trust, a plan, past approvals and a successful result do not authorize another action.',
    '- Provider starts and selected-context disclosures each require recipient-bound approval. Deterministic gate commands require approval of the exact command plan. Commits require approval of the exact tree. Deployments, when supported, require their own approval; planning does not schedule a deployment.',
    ...(['R3', 'R4'].includes(manifest.task.risk) ? [`- **${p(manifest.task.risk, 8)}:** final readiness requires a human decision${manifest.task.risk === 'R4' ? '; destructive/production side effects also require explicit approval before the action' : ''}.`] : []),
    '',
    '### Stored acceptance criteria',
    '',
    ...(manifest.task.acceptanceCriteria.length ? manifest.task.acceptanceCriteria.map((item) => `- ${p(item)}`) : ['Not recorded. Acceptance criteria are desired outcomes, not evidence that a check ran.']),
    '',
    '### Stored constraints',
    '',
    ...(manifest.task.constraints?.length ? manifest.task.constraints.map((item) => `- ${p(item)}`) : ['Not recorded.']),
    '',
    'Re-plan through the supported CLI/configuration when the objective, risk or selection needs changing; this read-only summary does not alter an assignment.',
    '',
  ];
  if (snapshot?.checks.state === 'recorded') {
    lines.push('### Planned checks at original repository', '',
      ...(snapshot.checks.gates.length ? snapshot.checks.gates.map((gate) => `- ${p(gate.profile, 80)} / ${p(gate.id, 80)} (configured ${gate.configuredBlocking ? 'blocking' : 'advisory'}): ${code(formatCommand([gate.executable ?? gate.command, ...(gate.prefixArgs ?? []), ...gate.args]), 1000)}; timeout ${gate.timeoutMs} ms; ${gate.missing.length ? `missing prerequisites: ${gate.missing.map((item) => p(item, 200)).join('; ')} (execution would block)` : 'no missing prerequisites observed at capture'}.`) : ['No applicable checks were detected. This does not establish readiness.']),
      '', 'This bounded preview is not permission to run commands or proof of current prerequisites. The runtime rechecks the worktree and exact command plan before approval.', '');
  }
  lines.push('## Assignments', '', '| Role | Agent | Status | Recommendation |', '|---|---|---|---|');
  for (const assignment of manifest.assignments) {
    const result = manifest.results.find((item) => item.assignmentId === assignment.id);
    lines.push(`| ${p(assignment.role, 40)} | ${p(assignment.agentId, 60)} | ${result ? p(result.status, 40) : progress.get(assignment.id)!.state} | ${result ? p(result.recommendation, 40) : ''} |`);
  }
  lines.push('', '## Execution dependencies and observations', '', '| Assignment | Provider / harness / surface | Stance | Billing lane | Depends on | Observed state | Authority |', '|---|---|---|---|---|---|---|');
  for (const assignment of manifest.assignments) {
    const observation = progress.get(assignment.id)!;
    lines.push(`| ${p(assignment.id, 80)} | ${p(assignment.provider, 60)} / ${p(assignment.harness, 60)} / ${p(assignment.surface ?? 'unknown', 40)} | ${p(assignment.stance, 30)} | ${p(assignment.billingChannel, 30)} | ${assignment.dependsOn.map((id) => p(id, 80)).join(', ') || 'none'} | ${observation.state}${observation.observedAt ? ` (${p(observation.observedAt, 40)})` : ''} | ${assignment.authority.map((item) => p(item, 40)).join(', ')} |`);
  }
  lines.push('', '### Chosen provider and recorded evidence', '');
  for (const assignment of manifest.assignments) {
    const result = manifest.results.find((item) => item.assignmentId === assignment.id);
    const inventory = snapshot?.providers.find((item) => item.harness === assignment.harness && item.provider === assignment.provider && item.surface === (assignment.surface ?? 'unknown'));
    const inventoryText = inventory ? `Planning inventory: ${inventory.inventory}; local client ${inventory.localClientRequired ? 'required' : 'not required by selected surface'}. This is adapter discovery, not authentication or trust.` : 'Planning inventory: not recorded for this selection.';
    lines.push(`- ${p(assignment.id, 80)}: chosen ${p(assignment.provider, 60)} / ${p(assignment.harness, 60)} / ${p(assignment.surface ?? 'unknown', 40)}; ${result ? `recorded result ${p(result.status, 40)} from ${p(result.provider, 60)} / ${p(result.harness, 60)} / ${p(result.surface ?? 'surface not recorded', 40)}` : 'no result recorded'}. Current availability/trust is not established by this record. ${inventoryText}`);
  }
  if (snapshot) {
    lines.push('', '### Configured harness inventory at planning', '', '| Harness | Provider / surface | Local client required | Inventory membership |', '|---|---|---|---|');
    for (const provider of snapshot.providers) lines.push(`| ${p(provider.harness, 60)} | ${p(provider.provider, 60)} / ${p(provider.surface, 40)} | ${provider.localClientRequired ? 'yes' : 'no'} | ${p(provider.inventory, 30)} |`);
    lines.push('', 'Inventory membership is not role eligibility, authentication, health, workstation trust or present readiness. Absent manual/platform clients may be valid native handoffs; no alternative is automatically selected here.', '');
  }
  lines.push('', 'Billing lanes are planned channels, not proof of the client account or permission to incur API charges.', '');
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
