import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { confirmInterview, interviewDraft, previewInterview, INTERVIEW_FIELDS, type InterviewState, type InterviewOrigins } from '@code-conductor/runtime/interview';

/** Explicit setup only. Saved answers are private; generated project files stay proposals. */
export async function runInterview(context: vscode.ExtensionContext, root: string, stillSelected: () => boolean): Promise<void> {
  const key = `codeConductor.interview.${createHash('sha256').update(root).digest('hex')}`;
  const stored = await context.secrets.get(key);
  let previous: InterviewState | undefined;
  try {
    previous = stored ? JSON.parse(stored) as InterviewState : undefined;
    if (stored && !previous) throw new Error('Invalid saved interview.');
    interviewDraft(root, previous);
  } catch {
    const recover = await vscode.window.showWarningMessage('Saved interview answers could not be validated. Start a new draft from defaults? The saved data will remain until you preview and save new answers.', 'Start new draft', 'Cancel');
    if (recover !== 'Start new draft' || !stillSelected()) return;
    previous = undefined;
  }
  const answers = interviewDraft(root, previous);
  const origins: InterviewOrigins = previous ? { ...previous.origins } : { mission: 'default', priorities: 'default', style: 'default' };
  const choice = await vscode.window.showQuickPick(previous ? ['Use current answers', 'Customize', 'Reset to defaults'] : ['Use defaults', 'Customize'], { placeHolder: previous ? 'Redo orchestrator interview' : 'Set up your orchestrator — start with defaults or customize' });
  if (!choice || !stillSelected()) return;
  if (choice === 'Reset to defaults') {
    Object.assign(answers, interviewDraft(root));
    for (const field of INTERVIEW_FIELDS) origins[field] = 'default';
  }
  if (choice === 'Customize') {
    const prompts = { mission: 'What should the team accomplish, and what defines success?', priorities: 'What constraints and preferences matter?', style: 'How should the orchestrator communicate and collaborate?' };
    for (const field of INTERVIEW_FIELDS) {
      const value = await vscode.window.showInputBox({ title: `Orchestrator setup (${INTERVIEW_FIELDS.indexOf(field) + 1}/3)`, prompt: prompts[field], value: answers[field], ignoreFocusOut: true, validateInput: (value) => {
        try { confirmInterview(root, { ...answers, [field]: value }); return undefined; }
        catch (error) { return error instanceof Error ? error.message : 'Invalid answer.'; }
      } });
      if (value === undefined || !stillSelected()) return;
      if (answers[field] !== value) origins[field] = 'user-input';
      answers[field] = value;
    }
  }
  const state = confirmInterview(root, answers, origins);
  const preview = previewInterview(state);
  const content = ['Orchestrator setup preview — draft', ...preview.outstanding, '', ...preview.files.flatMap((file) => [file.path, file.content, ''])].join('\n');
  const document = await vscode.workspace.openTextDocument({ content, language: 'plaintext' });
  if (!stillSelected()) return;
  await vscode.window.showTextDocument(document, { preview: true });
  const save = await vscode.window.showInformationMessage('Save these interview answers privately for this repository? Project files remain draft proposals pending metadata and AI review.', 'Save answers', 'Cancel');
  if (save !== 'Save answers' || !stillSelected()) return;
  // Refuse stale dialogs if another setup changed the saved baseline meanwhile.
  if (await context.secrets.get(key) !== stored) throw new Error('Interview answers changed during setup. Reopen the interview.');
  if (!stillSelected()) return;
  await context.secrets.store(key, JSON.stringify(state));
}
