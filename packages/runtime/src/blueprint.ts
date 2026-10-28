import { createHash } from 'node:crypto';
import { previewInterview, type InterviewState } from './interview.js';
import { validateTeamAdvice, type TeamInputs } from './orchestration-graph.js';

export interface BlueprintFile { path: string; content: string; sha256: string }
export interface BlueprintProposal {
  version: 1;
  status: 'proposal';
  repository: string;
  interviewDigest: string;
  inputDigest: string;
  files: BlueprintFile[];
  digest: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export const BLUEPRINT_BEGIN = '<!-- Code Conductor managed context: begin -->';
export const BLUEPRINT_END = '<!-- Code Conductor managed context: end -->';

/** Deterministic rendering of validated advice. This is not a review receipt or approval. */
export function proposeBlueprint(interview: InterviewState, inputs: TeamInputs, advice: unknown): BlueprintProposal {
  const draft = previewInterview(interview);
  const team = validateTeamAdvice(advice, inputs);
  const agents = new Map(inputs.agents.map((agent) => [agent.id, agent]));
  const assignments = [...team.assignments].sort((a, b) => order(a.id, b.id));
  if (assignments.some((item) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(item.id) || item.id.endsWith('.'))) throw new Error('Blueprint handoff name is unsupported on a supported filesystem.');
  const teamLines = assignments.map((item) => {
    const agent = agents.get(item.agentId)!;
    return `- ${item.id}: ${item.role}, agent ${agent.id}, provider ${agent.provider}, binding ${agent.binding}; source SHA-256 ${agent.sourceDigest}; dependencies: ${[...item.dependsOn].sort().join(', ') || 'none'}.`;
  });
  const inventory = [...inputs.agents].sort((a, b) => order(a.id, b.id));
  const additions: Record<string, string> = {
    '.agent/IDENTITY.md': `\n## Proposed team\n\n${teamLines.join('\n')}\n`,
    '.agent/SKILLS.md': `\n## Validated metadata capability index\n\n${inventory.map((agent) => `- ${agent.id}: ${[...agent.capabilities].sort().join(', ') || 'none declared'}; source SHA-256 ${agent.sourceDigest}.`).join('\n')}\n\nCapabilities describe supplied metadata, not execution permissions.\n`,
    '.agent/TOOLS.md': `\n## Declared execution bindings\n\n${inventory.map((agent) => `- ${agent.id}: ${agent.provider}, ${agent.binding}.`).join('\n')}\n\nReadiness and action approval must be checked again at execution. Manual agents require an explicit handoff and must never be reported as a named native execution.\n`,
  };
  const raw = draft.files.map(({ path, content }) => ({ path, content: content + (additions[path] ?? '') }));
  const manifest = {
    version: 1, status: 'proposal', repository: interview.repository,
    interviewDigest: interview.digest, inputDigest: inputs.digest,
    agents: inventory.map((agent) => ({ ...agent, capabilities: [...agent.capabilities].sort() })),
    assignments: assignments.map((item) => ({ ...item, dependsOn: [...item.dependsOn].sort(), handoff: `.agent/handoffs/${item.id}.md` })),
  };
  raw.push({ path: '.agent/orchestration.json', content: JSON.stringify(manifest, null, 2) + '\n' });
  raw.push({ path: '.agent/ORCHESTRATOR.md', content: [
    '# Orchestrator', '', 'Proposal — acceptance, file application and runtime activation are separate steps.', '',
    `Interview SHA-256: ${interview.digest}`, `Input SHA-256: ${inputs.digest}`, '',
    '## Team and handoffs', '', ...teamLines, '',
    '## Execution rules', '',
    'Use the existing Code Conductor planner, policy and approval gates. This file grants no authority.',
    'Wait for all recorded dependencies and verify their evidence before handing off. Preserve role and provider separation.',
    'Carry the task, recipient, source revision, expected output, checks and evidence references in each runtime handoff.',
    'Treat agent output as claims until verified. Block missing or stale inputs; never substitute a generic invocation for a named specialist silently.', '',
  ].join('\n') });
  for (const item of assignments) raw.push({ path: `.agent/handoffs/${item.id}.md`, content: [
    `# Handoff: ${item.id}`, '', `Role: ${item.role}`, `Recipient agent: ${item.agentId}`,
    `Binding: ${agents.get(item.agentId)!.binding}`, `Dependencies: ${[...item.dependsOn].sort().join(', ') || 'none'}`, '',
    '## Required per-run fields', '',
    '- Task and acceptance criteria', '- Recipient and permitted authority from current policy',
    '- Source revision and committed changes', '- Dependency evidence and unresolved findings',
    '- Expected output and verification checks', '- Expiry and escalation conditions', '',
    'Populate through the runtime handoff protocol. This template is not evidence that a task ran or an approval was granted.', '',
  ].join('\n') });
  // Case-insensitive targets must not collapse distinct assignment IDs on Windows/macOS.
  if (new Set(raw.map((file) => file.path.toLowerCase())).size !== raw.length) throw new Error('Blueprint file names collide on a supported filesystem.');
  const files = raw.sort((a, b) => order(a.path, b.path)).map((file) => {
    // A marker is a layout delimiter, never ownership proof. The accepted private
    // baseline is required to replace a region or retire an old handoff.
    if (file.content.includes(BLUEPRINT_BEGIN) || file.content.includes(BLUEPRINT_END)) throw new Error('Blueprint input contains a reserved managed-region delimiter.');
    const content = file.path.endsWith('.md') ? `${BLUEPRINT_BEGIN}\n${file.content}${BLUEPRINT_END}\n` : file.content;
    return { path: file.path, content, sha256: hash(content) };
  });
  if (files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 1048576) throw new Error('Blueprint exceeds the 1 MiB proposal limit.');
  const proposal = { version: 1 as const, status: 'proposal' as const, repository: interview.repository, interviewDigest: interview.digest, inputDigest: inputs.digest, files };
  return { ...proposal, digest: hash(JSON.stringify(proposal)) };
}
