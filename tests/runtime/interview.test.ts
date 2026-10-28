import { describe, expect, it } from 'vitest';
import { confirmInterview, interviewDraft, INTERVIEW_DEFAULTS, previewInterview } from '../../packages/runtime/src/interview.js';

describe('repository interview', () => {
  it('starts with three defaults and leaves confirmed answers unchanged during Redo or cancel', () => {
    const initial = interviewDraft('/project');
    expect(Object.keys(initial)).toEqual(['mission', 'priorities', 'style']);
    const saved = confirmInterview('/project', initial);
    const redo = interviewDraft('/project', saved);
    redo.mission = 'Changed draft';
    expect(saved.answers.mission).toBe(INTERVIEW_DEFAULTS.mission);
    expect(interviewDraft('/project', saved)).toEqual(initial);
    expect(confirmInterview('/project', redo).digest).not.toBe(saved.digest);
  });
  it('rejects another repository or edited saved answers', () => {
    const saved = confirmInterview('/project', interviewDraft('/project'));
    expect(() => interviewDraft('/other', saved)).toThrow(/repository/);
    saved.answers.style = 'Tampered';
    expect(() => interviewDraft('/project', saved)).toThrow(/recorded answers/);
  });
  it('refuses blank, oversized, control-containing and extra answers', () => {
    for (const mission of ['', ' ', 'x'.repeat(8001), 'a\u0000b', 'a\u202eb']) expect(() => confirmInterview('/project', { ...INTERVIEW_DEFAULTS, mission })).toThrow();
    expect(() => confirmInterview('/project', { ...INTERVIEW_DEFAULTS, extra: 'unexpected' } as never)).toThrow();
  });
  it('preserves accepted-default origins separately from user confirmation and screens known secrets', () => {
    const origins = { mission: 'default', priorities: 'default', style: 'default' } as const;
    const saved = confirmInterview('/project', interviewDraft('/project'), origins);
    expect(previewInterview(saved).files[0]?.content).toContain('mission: default (user confirmed)');
    expect(() => confirmInterview('/project', { ...INTERVIEW_DEFAULTS, mission: 'Changed' }, origins)).toThrow(/provenance/);
    const credential = 'ghp_' + 'a'.repeat(36);
    expect(() => confirmInterview('/project', { ...INTERVIEW_DEFAULTS, mission: credential })).toThrow(/credential-like/);
  });
  it('produces ten fixed draft paths without fabricating installed skills or historical memory', () => {
    const saved = confirmInterview('/project', { ...INTERVIEW_DEFAULTS, mission: 'Ship the scheduling feature with passing acceptance tests.' });
    const preview = previewInterview(saved);
    expect(preview.status).toBe('draft');
    expect(preview.files).toHaveLength(10);
    expect(new Set(preview.files.map((file) => file.path)).size).toBe(10);
    expect(preview.files.find((file) => file.path === '.agent/GOALS.md')?.content).toContain(saved.answers.mission);
    expect(preview.files.find((file) => file.path === '.agent/MEMORY.md')?.content).toContain('No historical decisions');
    expect(preview.files.every((file) => file.content.includes('review pending'))).toBe(true);
    expect(previewInterview(saved)).toEqual(preview);
  });
});
