import { recoveryPointer, summarizeToolOutput } from '@code-conductor/context-optimizer/tool-output';
import type { RunStore } from '@code-conductor/evidence';
import { BOUNDED_OUTPUT_CHARS, type GateExecutionOptions, type GateOutputContext } from '@code-conductor/gates';

/**
 * How a gate's output appears in its evidence record (#94, ADR 0007, D-071).
 *
 * - `bounded` (default): the first 8,000 characters, as before.
 * - `summary`: a deterministic, verbatim-line summary from the context optimizer: the
 *   output's own head and tail, its counts, its failure blocks and its error-looking
 *   lines, with everything left out counted. Opt-in only.
 *
 * In both modes the full output is stored owner-private with the run and every record
 * ends with a recovery pointer: the stored path and the evidence digest. The verdict
 * comes from the exit status, never from the text shown.
 */
export type ToolOutputMode = 'bounded' | 'summary';

export const TOOL_OUTPUT_MODES: readonly ToolOutputMode[] = ['bounded', 'summary'];

export interface ToolOutputTelemetry {
  evidenceId: string;
  mode: ToolOutputMode;
  kind?: string;
  originalBytes: number;
  /** Local character-count estimates for relative telemetry, never billing or quota data. */
  estimatedTokens: { original: number; shown: number; exact: false };
}

/**
 * The gate render hook for a run: stores each gate's full output in the run store and
 * decides what the evidence shows under the headline. `onRecorded` receives the
 * estimate telemetry, so a run can measure what the mode saves (issue #94's baseline).
 */
export function gateOutputRenderer(store: RunStore, runId: string, mode: ToolOutputMode, onRecorded?: (telemetry: ToolOutputTelemetry) => void): NonNullable<GateExecutionOptions['render']> {
  return (context: GateOutputContext) => {
    const stored = store.saveToolOutput(runId, {
      evidenceId: context.evidenceId, source: `${context.commandLine} (${context.executable})`, status: context.outcome.status, timedOut: context.outcome.timedOut === true, truncated: context.outcome.truncated === true,
      stdout: context.outcome.stdout, stderr: context.outcome.stderr, sha256: context.sha256, digestMethod: context.outcome.sha256 ? 'streams' : 'combined',
    });
    const pointer = recoveryPointer({ path: stored.path, sha256: context.sha256, ...(context.outcome.truncated ? { truncated: true } : {}) });
    // The optimizer's estimate (characters divided by four): relative telemetry only.
    const estimate = (text: string): number => Math.max(0, Math.ceil(text.trim().length / 4));
    let body: string;
    let kind: string | undefined;
    if (mode === 'summary') {
      const summary = summarizeToolOutput(context.combined);
      kind = summary.kind;
      body = summary.verbatim ? summary.summary : `[Summary of ${summary.originalLines} line(s), ${summary.originalBytes} bytes; ${summary.elidedLines} line(s) not shown. Every line below is verbatim.]\n${summary.summary}`;
    } else {
      body = context.combined.slice(0, BOUNDED_OUTPUT_CHARS);
    }
    const text = body ? `${body}\n${pointer}` : pointer;
    onRecorded?.({ evidenceId: context.evidenceId, mode, ...(kind ? { kind } : {}), originalBytes: Buffer.byteLength(context.combined, 'utf8'), estimatedTokens: { original: estimate(context.combined), shown: estimate(body), exact: false } });
    return { text, uri: stored.path };
  };
}
