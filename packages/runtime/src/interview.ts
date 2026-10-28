import { createHash } from 'node:crypto';
import { redactSecrets } from '@code-conductor/git';

export const INTERVIEW_FIELDS = ['mission', 'priorities', 'style'] as const;
export type InterviewField = typeof INTERVIEW_FIELDS[number];
export type InterviewAnswers = Record<InterviewField, string>;
export type InterviewOrigins = Record<InterviewField, 'default' | 'user-input'>;
export interface InterviewState {
  version: 1;
  repository: string;
  answers: InterviewAnswers;
  origins: InterviewOrigins;
  digest: string;
}
export const INTERVIEW_DEFAULTS: Readonly<InterviewAnswers> = Object.freeze({
  mission: 'Deliver the project’s agreed outcomes with verified results. Define project-specific success criteria before execution.',
  priorities: 'Follow repository policy, preserve human work, validate changes, and report uncertainty and blockers.',
  style: 'Be pragmatic, curious, and concise. Explain decisions clearly and challenge unsupported assumptions.',
});

function checked(answers: InterviewAnswers): InterviewAnswers {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).some((key) => !INTERVIEW_FIELDS.includes(key as InterviewField))) throw new Error('Unsupported interview answers.');
  const result = {} as InterviewAnswers;
  for (const field of INTERVIEW_FIELDS) {
    const value = answers[field];
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) throw new Error('Each interview answer must contain bounded, readable text.');
    if (redactSecrets(value).redacted) throw new Error('Remove credential-like values from interview answers.');
    result[field] = value;
  }
  return result;
}

/** Pure draft operation: cancel by discarding the result; previous answers stay intact. */
export function interviewDraft(repository: string, previous?: InterviewState): InterviewAnswers {
  if (previous) {
    const verified = confirmInterview(repository, previous.answers, previous.origins);
    if (previous.version !== 1 || previous.repository !== repository || previous.digest !== verified.digest) throw new Error('Saved interview does not match this repository or its recorded answers.');
    return { ...verified.answers };
  }
  return { ...INTERVIEW_DEFAULTS };
}

/** Confirmation records user input only; it is never deployment or provider approval. */
export function confirmInterview(repository: string, answers: InterviewAnswers, origins: InterviewOrigins = { mission: 'user-input', priorities: 'user-input', style: 'user-input' }): InterviewState {
  if (typeof repository !== 'string' || !repository.trim() || repository.length > 4096 || /[\u0000-\u001f]/.test(repository)) throw new Error('A repository identity is required.');
  if (!origins || Object.keys(origins).length !== 3 || INTERVIEW_FIELDS.some((field) => origins[field] !== 'default' && origins[field] !== 'user-input')) throw new Error('Unsupported interview provenance.');
  if (INTERVIEW_FIELDS.some((field) => origins[field] === 'default' && answers[field] !== INTERVIEW_DEFAULTS[field])) throw new Error('Default provenance does not match the default answer.');
  const state = { version: 1 as const, repository, answers: checked(answers), origins: { mission: origins.mission, priorities: origins.priorities, style: origins.style } };
  return { ...state, digest: createHash('sha256').update(JSON.stringify(state)).digest('hex') };
}

export const BLUEPRINT_FILES = ['SOUL', 'IDENTITY', 'INSTRUCTIONS', 'GUARDRAILS', 'SKILLS', 'TOOLS', 'CONTEXT', 'MEMORY', 'KNOWLEDGE', 'GOALS'] as const;
export interface InterviewPreview {
  status: 'draft';
  interviewDigest: string;
  files: { path: string; content: string; sha256: string }[];
  outstanding: string[];
}

/** Fixed first-party templates only. No filesystem access, model call or runtime authority. */
export function previewInterview(state: InterviewState): InterviewPreview {
  const answers = interviewDraft(state.repository, state);
  const text: Record<typeof BLUEPRINT_FILES[number], string> = {
    SOUL: `## Confirmed working style\n\n${answers.style}`,
    IDENTITY: 'Coordinate the project team through Code Conductor. Specialist identities and domains await installed-pack analysis.',
    INSTRUCTIONS: 'Follow governing repository instructions. Identify responsible agents, dependencies, expected outputs and evidence before handoff. Verify results before claiming completion.',
    GUARDRAILS: 'Repository policy and runtime approvals remain authoritative. Preserve human work, protect credentials, and report missing capabilities or evidence. This document grants no permissions.',
    SKILLS: 'Installed skill references and immutable source versions await metadata validation. No skill capabilities have been inferred from interview answers.',
    TOOLS: 'Declared tool references await verified metadata. Availability and permission must be checked privately at execution time.',
    CONTEXT: 'Project phase and active task are not established by this interview. Record verified current facts separately from durable memory.',
    MEMORY: `## Confirmed preferences\n\n${answers.style}\n\n## Decisions and lessons\n\nNo historical decisions or lessons were supplied by this interview. Preserve existing human-authored memory when preparing the application diff.`,
    KNOWLEDGE: 'Curated project references and architecture decisions await source validation. No example technology or external reference has been assumed.',
    GOALS: `## Confirmed mission and success\n\n${answers.mission}\n\n## Confirmed priorities and constraints\n\n${answers.priorities}`,
  };
  return {
    status: 'draft', interviewDigest: state.digest,
    files: BLUEPRINT_FILES.map((name) => {
      const provenance = INTERVIEW_FIELDS.map((field) => `${field}: ${state.origins[field]} (user confirmed)`).join('; ');
      const content = `# ${name}\n\nDraft proposal — metadata analysis and approved AI review pending.\n\nInterview provenance: ${provenance}.\n\n${text[name]}\n`;
      return { path: `.agent/${name}.md`, content, sha256: createHash('sha256').update(content).digest('hex') };
    }),
    outstanding: ['Validate installed pack metadata and capabilities.', 'Complete approved AI review and validate the resulting team/handoff graph.', 'Compare existing files and preserve human edits before approved application.'],
  };
}
