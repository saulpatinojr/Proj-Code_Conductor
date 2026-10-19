import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
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
 * Read the manifest file through one descriptor, so the size that is checked is the size
 * of the file that is read: no symlink is followed at the final component, a FIFO cannot
 * block, and a file that grows past the bound while it is read is refused.
 */
function readManifestFile(file: string): string {
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('Run manifest must be a regular file.');
    if (stat.size > MAX_IMPORT_BYTES) throw new Error(`Run manifest exceeds ${MAX_IMPORT_BYTES} bytes.`);
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length;) {
      read = readSync(descriptor, buffer, length, buffer.length - length, null);
      length += read;
    }
    if (length > stat.size) throw new Error('Run manifest changed while it was read.');
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(descriptor); }
}

/**
 * Import an externally produced RunManifest (for example Code Workflow's
 * `workflow.py export`) into the owner-private run store, so the Runs view and
 * later Code Conductor review can inspect it. ADR 0011.
 *
 * Imported evidence is never treated as readiness. Manifests that carry a
 * mergeDecision or a `ready` recommendation are rejected: readiness belongs to
 * Code Conductor's own independent review and deterministic gates. Approval
 * and worktree records are rejected too: they would look like this store's own evidence.
 */
export function importRunManifest(file: string, options: ImportOptions = {}): ImportOutcome {
  const parsed = JSON.parse(readManifestFile(file)) as unknown;
  assertContract('RunManifest', parsed);
  const manifest = parsed as RunManifest;
  if (manifest.mergeDecision) {
    throw new Error('Imported manifests must not carry a mergeDecision; readiness is decided by Code Conductor review and gates (ADR 0011).');
  }
  if (manifest.approvals?.length) {
    throw new Error('Imported manifests must not carry approval records; pre-action approvals are local, single-use evidence of decisions made in this Code Conductor run store (ADR 0013).');
  }
  if (manifest.handoffs?.length) {
    throw new Error('Imported manifests must not carry handoff packets; packets are created and digest-checked by this Code Conductor run store (D-063).');
  }
  if (manifest.worktrees?.length) {
    throw new Error('Imported manifests must not carry worktree records; only worktrees this Code Conductor created are offered for native review (D-060).');
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
