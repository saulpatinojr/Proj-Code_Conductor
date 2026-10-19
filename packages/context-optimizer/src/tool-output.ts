import { estimateTokens } from './optimizer.js';

/**
 * Recoverable summaries of deterministic tool output (#94, ADR 0007).
 *
 * A gate's test log, lint output or JSON report is the noisiest input Code Conductor
 * controls, and it is deterministic, so it can be shrunk mechanically before a person
 * or an agent reads it. The rules, in order of precedence:
 *
 * - the verdict never comes from a summary: gates pass or fail on their exit status and
 *   the full output stays stored, so every summary ends with a recovery pointer (the
 *   stored path and the SHA-256 of the full output);
 * - every line the summary keeps is kept verbatim: error messages, file paths, line
 *   numbers, counts and exit codes are never rewritten, reflowed or abbreviated;
 * - what is left out is counted, never silently dropped;
 * - output that already fits is returned as it is;
 * - the functions here are pure: no clock, no randomness, no network, no file access, so
 *   the same output always gives the same summary.
 *
 * Summaries apply only to tool output. Instructions, policy, acceptance criteria and
 * security rationale are never summarised (AGENTS.md §12).
 */

export type ToolOutputKind = 'json' | 'test' | 'log';

export interface ToolOutputSummaryOptions {
  /** Upper bound on the summary text, in characters (default 4000). */
  maxChars?: number;
  /** Lines kept verbatim from the start of the output (default 10). */
  head?: number;
  /** Lines kept verbatim from the end of the output, where runners print their counts (default 15). */
  tail?: number;
  /** Failure blocks kept verbatim in test output (default 5). */
  failures?: number;
}

export interface ToolOutputSummary {
  kind: ToolOutputKind;
  /** The summary text; equals the original when it already fit. */
  summary: string;
  /** True when the original was returned unchanged. */
  verbatim: boolean;
  originalBytes: number;
  originalLines: number;
  /** Lines of the original that the summary does not show verbatim (0 when verbatim). */
  elidedLines: number;
  /** Local character-count estimates for relative telemetry, never billing data. */
  estimatedTokens: { original: number; summary: number; exact: false };
}

/** Where the full output is stored, so a summary can always be traced back to it. */
export interface RecoveryReference {
  /** Path of the stored record, owner-private, under the run's evidence directory. */
  path: string;
  /** SHA-256 of the full output, as recorded in the evidence. */
  sha256: string;
  /** Output beyond the capture bound was not stored; the digest still covers it. */
  truncated?: boolean;
}

const DEFAULTS = { maxChars: 4000, head: 10, tail: 15, failures: 5 } as const;

// A line that most likely carries a verdict, an error or a location. Matching is on the
// whole line; a matched line is kept exactly as it is.
const SIGNAL = /(\b(error|errors|fail|failed|failure|failures|failing|exception|traceback|panic|fatal|assert|assertion|assertionerror|not ok|warn|warning|warnings|denied|refused|timed out|timeout|exit code|exited with)\b|[✗×✖❌]|\.[A-Za-z]{1,10}:\d+\b)/i;
// Lines runners print as totals: "Tests  2 failed | 40 passed (42)", "Tests: 1 failed, 3 total",
// "# fail 1", "3 failed, 10 passed in 0.5s", "ok 1 - name" style totals are kept by the tail.
const COUNTS = /(\b\d+\s+(passed|failed|skipped|pending|todo|errors?|warnings?|failures?)\b|^#\s+(pass|fail|tests|skipped|todo)\s+\d+|^\s*Tests?:?\s+\d|^\s*Test (Files|Suites):?\s+\d|\bexit(ed with)? code\b)/i;
const TEST_SHAPE = /(\bTests?:?\s+\d+|\b\d+\s+(passed|failed|skipped|pending)\b|^#\s+(pass|fail)\s+\d+|^(ok|not ok)\s+\d+|^\s*(PASS|FAIL)\b|^\s*[✓✗×✖]|\bAssertionError\b|^\s*(FAILED|PASSED)\b|\bpytest\b|\bvitest\b|\bjest\b)/im;
// The first line of a failure block in common runners.
const FAILURE_START = /(^\s*(FAIL|FAILED|ERROR|not ok)\b|^\s*[✗×✖❌]|^\s*●|\bAssertionError\b|^Traceback \(most recent call last\)|^\s*\d+\)\s)/;

/** Which summariser fits an output: parseable JSON, a test runner's report, or a plain log. */
export function classifyToolOutput(text: string): ToolOutputKind {
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* not a single JSON document */ }
  }
  return TEST_SHAPE.test(text) ? 'test' : 'log';
}

/** The pointer every summary (and every stored gate evidence) ends with. */
export function recoveryPointer(reference: RecoveryReference): string {
  return `Full output: ${reference.path} (sha256 ${reference.sha256}${reference.truncated ? '; output beyond the capture bound was not stored, the digest covers it' : ''}). The gate verdict comes from the exit status and the full output, not from this summary.`;
}

function describeJson(value: unknown, depth = 0): { text: string; depth: number } {
  if (Array.isArray(value)) {
    let deepest = depth;
    for (const item of value) deepest = Math.max(deepest, describeJson(item, depth + 1).depth);
    return { text: `array[${value.length}]`, depth: deepest };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    let deepest = depth;
    for (const key of keys) deepest = Math.max(deepest, describeJson((value as Record<string, unknown>)[key], depth + 1).depth);
    return { text: `object{${keys.length}}`, depth: deepest };
  }
  if (typeof value === 'string') return { text: `string(${value.length})`, depth };
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return { text: String(value), depth };
  return { text: typeof value, depth };
}

const MAX_JSON_KEYS = 50;
/** Count lines kept from each end of the output when a runner prints many of them. */
const MAX_COUNT_LINES = 20;

function summarizeJson(text: string, bytes: number, lines: number): string {
  const value = JSON.parse(text.trim()) as unknown;
  const shape = describeJson(value);
  const header = `JSON ${shape.text}, ${bytes} bytes, ${lines} line(s), depth ${shape.depth}.`;
  if (Array.isArray(value)) {
    const kinds = new Map<string, number>();
    for (const item of value) { const kind = describeJson(item).text.split(/[[{(]/, 1)[0] ?? ''; kinds.set(kind, (kinds.get(kind) ?? 0) + 1); }
    return `${header} Items: ${[...kinds].map(([kind, count]) => `${count} ${kind}`).join(', ') || 'none'}.`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, MAX_JSON_KEYS).map(([key, item]) => `${JSON.stringify(key)}: ${describeJson(item).text}`);
    return `${header} Top-level keys: ${shown.join(', ') || 'none'}${entries.length > shown.length ? `, and ${entries.length - shown.length} more` : ''}.`;
  }
  return header;
}

interface Kept { index: number; line: string; repeats: number }

/** Collapse runs of identical consecutive lines; the first occurrence stays verbatim and the count is separate. */
function collapseRepeats(lines: readonly string[]): Kept[] {
  const kept: Kept[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const previous = kept.at(-1);
    if (previous && previous.line === line && previous.index + previous.repeats + 1 === index) { previous.repeats += 1; continue; }
    kept.push({ index, line, repeats: 0 });
  }
  return kept;
}

function render(kept: readonly Kept[], chosen: ReadonlySet<number>): { text: string; elided: number } {
  const parts: string[] = [];
  let elided = 0;
  let pending = 0;
  const flush = (): void => { if (pending) { parts.push(`[… ${pending} line(s) elided; see the full output]`); elided += pending; pending = 0; } };
  for (const item of kept) {
    const span = item.repeats + 1;
    if (!chosen.has(item.index)) { pending += span; continue; }
    flush();
    parts.push(item.line);
    if (item.repeats) parts.push(`[previous line repeated ${item.repeats} more time(s)]`);
  }
  flush();
  return { text: parts.join('\n'), elided };
}

/**
 * Summarise one deterministic tool output. The output's own lines are the summary: the
 * head and tail, the runner's counts, every failure block up to `failures`, and every
 * other error-looking line while the budget lasts. Nothing kept is rewritten.
 */
export function summarizeToolOutput(text: string, options: ToolOutputSummaryOptions = {}): ToolOutputSummary {
  const settings = { ...DEFAULTS, ...options };
  const originalBytes = Buffer.byteLength(text, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const originalLines = lines.length;
  const originalTokens = estimateTokens(text);
  const done = (kind: ToolOutputKind, summary: string, verbatim: boolean, elidedLines: number): ToolOutputSummary => ({
    kind, summary, verbatim, originalBytes, originalLines, elidedLines,
    estimatedTokens: { original: originalTokens, summary: estimateTokens(summary), exact: false },
  });
  const kind = classifyToolOutput(text);
  if (text.length <= settings.maxChars && kind !== 'json') return done(kind, text, true, 0);
  if (kind === 'json') {
    if (text.length <= settings.maxChars) return done(kind, text, true, 0);
    return done(kind, summarizeJson(text, originalBytes, originalLines), false, originalLines);
  }

  const kept = collapseRepeats(lines);
  const chosen = new Set<number>();
  const add = (indexes: Iterable<number>): void => { for (const index of indexes) chosen.add(index); };

  // 1. Head and tail: the command line, the environment banner, the totals and the exit.
  add(kept.slice(0, settings.head).map((item) => item.index));
  add(kept.slice(-settings.tail).map((item) => item.index));
  // 2. Count lines ("3 failed, 10 passed"): the first and last few anywhere in the output.
  const counts = kept.filter((item) => COUNTS.test(item.line));
  add([...counts.slice(0, MAX_COUNT_LINES), ...counts.slice(-MAX_COUNT_LINES)].map((item) => item.index));
  // 3. Failure blocks, verbatim, in order, up to the limit: from the failure line to the next blank line.
  if (kind === 'test') {
    let blocks = 0;
    for (let position = 0; position < kept.length && blocks < settings.failures; position += 1) {
      if (!FAILURE_START.test(kept[position]!.line)) continue;
      blocks += 1;
      for (let cursor = position; cursor < kept.length && (cursor === position || kept[cursor]!.line.trim() !== ''); cursor += 1) chosen.add(kept[cursor]!.index);
    }
  }
  // 4. Other error-looking lines while the budget lasts. The length is tracked
  //    incrementally (one pass over the output), not by rendering after each line.
  let length = render(kept, chosen).text.length;
  const added: number[] = [];
  for (const item of kept) {
    if (chosen.has(item.index) || !SIGNAL.test(item.line)) continue;
    if (length + item.line.length + 1 > settings.maxChars) break;
    chosen.add(item.index);
    added.push(item.index);
    length += item.line.length + 1;
  }
  // 5. Elision markers were not counted above: if the rendering is still over budget,
  //    give back the signal lines added last. Head, tail, counts and failure blocks stay.
  let rendered = render(kept, chosen);
  while (rendered.text.length > settings.maxChars && added.length) {
    chosen.delete(added.pop()!);
    rendered = render(kept, chosen);
  }
  return done(kind, rendered.text, false, rendered.elided);
}
