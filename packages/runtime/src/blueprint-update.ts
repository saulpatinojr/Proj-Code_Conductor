import { createHash } from 'node:crypto';
import { BLUEPRINT_BEGIN, BLUEPRINT_END, type BlueprintProposal } from './blueprint.js';

export interface BlueprintChange { path: string; before: string | null; after: string | null; beforeSha256: string | null; afterSha256: string | null }
export interface BlueprintUpdate { status: 'ready-for-preview' | 'conflict'; changes: BlueprintChange[]; conflicts: { path: string; reason: string }[] }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function check(proposal: BlueprintProposal): void {
  const { digest, ...body } = proposal;
  if (proposal.version !== 1 || proposal.status !== 'proposal' || hash(JSON.stringify(body)) !== digest || proposal.files.length > 268 || new Set(proposal.files.map((file) => file.path.toLowerCase())).size !== proposal.files.length) throw new Error('Invalid blueprint baseline or proposal.');
  for (const file of proposal.files) if (!/^\.agent\/(?:[A-Z]+\.md|orchestration\.json|handoffs\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.md)$/.test(file.path) || hash(file.content) !== file.sha256) throw new Error('Invalid blueprint artifact.');
}

/** Pure three-way proposal. Caller supplies an owner-private accepted baseline,
 * never a receipt discovered in project files. No write or acceptance occurs here.
 * Exact full before/after bytes must still pass the artifact application boundary. */
export function planBlueprintUpdate(next: BlueprintProposal, actual: ReadonlyMap<string, string>, accepted?: BlueprintProposal): BlueprintUpdate {
  check(next);
  if (accepted) { check(accepted); if (accepted.repository !== next.repository) throw new Error('Blueprint baseline belongs to another repository.'); }
  const previous = new Map(accepted?.files.map((file) => [file.path, file]) ?? []);
  const proposed = new Map(next.files.map((file) => [file.path, file]));
  const result: BlueprintUpdate = { status: 'ready-for-preview', changes: [], conflicts: [] };
  for (const path of [...new Set([...previous.keys(), ...proposed.keys()])].sort()) {
    const before = actual.get(path) ?? null;
    const old = previous.get(path); const desired = proposed.get(path);
    let after = desired?.content ?? null;
    const conflict = (reason: string) => { result.status = 'conflict'; result.conflicts.push({ path, reason }); };
    if (before === null) {
      if (old) { conflict('A previously accepted file is missing; review deletion before regeneration.'); continue; }
    } else if (!old) {
      conflict('Existing file has no accepted ownership baseline; preserve it and resolve explicitly.'); continue;
    } else if (before !== old.content) {
      if (!path.endsWith('.md') || !desired) { conflict('Human changes prevent replacement or removal.'); continue; }
      // Preserve only text outside the exact previously accepted managed region.
      // Duplicate or edited delimiters never acquire ownership by their appearance.
      const start = before.indexOf(BLUEPRINT_BEGIN);
      const end = before.indexOf(BLUEPRINT_END);
      if (start < 0 || end < start || before.indexOf(BLUEPRINT_BEGIN, start + 1) !== -1 || before.indexOf(BLUEPRINT_END, end + 1) !== -1 || before.slice(start, start + old.content.length) !== old.content) {
        conflict('Managed content changed; preserve human edits and resolve the proposal explicitly.'); continue;
      }
      after = before.slice(0, start) + desired.content + before.slice(start + old.content.length);
    }
    if (before !== after) result.changes.push({ path, before, after, beforeSha256: before === null ? null : hash(before), afterSha256: after === null ? null : hash(after) });
  }
  // A partial blueprint must never be passed as an applicable successful update.
  if (result.status === 'conflict') result.changes = [];
  return result;
}
