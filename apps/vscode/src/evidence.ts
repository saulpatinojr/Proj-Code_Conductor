import { readManifestToolOutput } from '@code-conductor/evidence';
import type { RunManifest } from '@code-conductor/schemas';
import { printable } from '@code-conductor/runtime/next-actions';
import { sameRepository } from './run-scope.js';

export const isCaptureId = (value: unknown): value is string => typeof value === 'string' && /^E-[A-Za-z0-9-]{8,80}$/.test(value);
/** Plain editor text, never Markdown, terminal commands or evidence-provided URIs. */
export function evidenceText(repository: string, storeRoot: string, manifest: RunManifest, evidenceId: string): string {
  if (!isCaptureId(evidenceId) || !sameRepository(repository, manifest.task.repository)) return 'Evidence is unavailable for the selected repository.';
  try {
    const { record } = readManifestToolOutput(storeRoot, manifest, evidenceId);
    const clean = (text: string): string => text.split('\n').map((line) => printable(line, Number.MAX_SAFE_INTEGER, false)).join('\n');
    const verdicts = [...new Set([...manifest.gates, ...manifest.results.flatMap((result) => result.tests)].filter((gate) => gate.evidenceIds.includes(evidenceId)).map((gate) => `${printable(gate.gate, 100, false)}: ${gate.status}`))];
    return [
      'Code Conductor stored gate output (read-only)',
      `Repository: ${printable(repository, 1000, false)}`,
      `Run: ${manifest.runId} · Evidence: ${evidenceId}`,
      `Source: ${printable(record.source, 1000, false)}`,
      `Manifest gate verdict: ${verdicts.join('; ') || 'not recorded'}`,
      `Full output SHA-256: ${record.sha256}`,
      'Stored output matches the digest recorded in this run manifest. This is local consistency, not independent verification or execution authority.',
      'Control/format characters are replaced for display; the digest covers the original captured bytes.',
      '', 'STDOUT', clean(record.stdout), '', 'STDERR', clean(record.stderr), '',
    ].join('\n');
  } catch { return 'Evidence is unavailable or cannot be verified against the selected manifest. Check missing, modified, ambiguous, legacy combined-digest or truncated capture files. No process was started.'; }
}
