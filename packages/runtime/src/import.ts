import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore, safeRunDirectoryName } from '@code-conductor/evidence';
import { assertContract, type RunManifest } from '@code-conductor/schemas';

const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

export interface ImportOptions {
  store?: RunStore;
  /** Free-text origin label recorded in the run event, e.g. `code-workflow`. */
  source?: string;
  /** Replace an existing imported run with the same id. */
  force?: boolean;
}

export interface ImportOutcome {
  runId: string;
  originalRunId: string;
  manifestPath: string;
  results: number;
}

/**
 * Import an externally produced RunManifest (for example Code Workflow's
 * `workflow.py export`) into the owner-private run store, so the Runs view and
 * later Code Conductor review can inspect it. ADR 0011.
 *
 * Imported evidence is never treated as readiness. Manifests that carry a
 * mergeDecision or a `ready` recommendation are rejected: readiness belongs to
 * Code Conductor's own independent review and deterministic gates.
 */
export function importRunManifest(file: string, options: ImportOptions = {}): ImportOutcome {
  const size = statSync(file).size;
  if (size > MAX_IMPORT_BYTES) throw new Error(`Run manifest exceeds ${MAX_IMPORT_BYTES} bytes.`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  assertContract('RunManifest', parsed);
  const manifest = parsed as RunManifest;
  if (manifest.mergeDecision) {
    throw new Error('Imported manifests must not carry a mergeDecision; readiness is decided by Code Conductor review and gates (ADR 0011).');
  }
  if (manifest.results.some((result) => result.recommendation === 'ready')) {
    throw new Error('Imported manifests must not recommend `ready`; readiness is decided by Code Conductor review and gates (ADR 0011).');
  }
  const store = options.store ?? new RunStore();
  const runId = manifest.runId.startsWith('import-') ? manifest.runId : `import-${manifest.runId}`;
  if (!options.force && existsSync(join(store.root, safeRunDirectoryName(runId), 'manifest.json'))) {
    throw new Error(`Run ${runId} already exists in the run store; pass --force to replace it.`);
  }
  const manifestPath = store.saveManifest({ ...manifest, runId });
  const source = options.source ?? 'external';
  store.appendEvent({
    at: new Date().toISOString(),
    runId,
    type: 'run.imported',
    message: `Imported ${manifest.results.length} result(s) from ${source}; readiness is not established by import.`,
    data: { originalRunId: manifest.runId, source },
  });
  return { runId, originalRunId: manifest.runId, manifestPath, results: manifest.results.length };
}
