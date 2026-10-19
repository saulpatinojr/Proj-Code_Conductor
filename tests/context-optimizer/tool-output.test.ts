import { describe, expect, it } from 'vitest';
import { classifyToolOutput, recoveryPointer, summarizeToolOutput } from '../../packages/context-optimizer/src/tool-output.js';

// A vitest-style report: a banner, many passing lines, two failures with paths and
// messages, repeated warnings, then the totals. Big enough to need summarising.
function testReport(): string {
  const lines: string[] = ['> @code-conductor/root@0.1.0 test', '> vitest run', '', ' RUN  v5.0.4 /work/repo', ''];
  for (let index = 0; index < 400; index += 1) lines.push(` ✓ tests/unit/case-${index}.test.ts (3 tests) ${index % 7}ms`);
  for (let index = 0; index < 30; index += 1) lines.push('stderr | warning: deprecated option "legacy" is ignored');
  lines.push(' ✗ tests/gates/profiles.test.ts > terraform profile > refuses -out (12ms)', '   AssertionError: expected "allowed" to be "refused"', '     at tests/gates/profiles.test.ts:88:21', '     expected: refused', '     received: allowed', '');
  lines.push(' ✗ tests/cli/mcp.test.ts > lists only official servers (4ms)', '   Error: ENOENT: no such file or directory, open \'/work/repo/config/mcp-catalog.yaml\'', '     at tests/cli/mcp.test.ts:17:5', '');
  lines.push(' Test Files  2 failed | 24 passed (26)', '      Tests  2 failed | 523 passed (525)', '   Start at  05:26:34', '   Duration  66.94s', 'exit code 1');
  return lines.join('\n');
}

describe('recoverable tool-output summaries (#94)', () => {
  it('is deterministic and pure: the same output gives the same summary', () => {
    const report = testReport();
    expect(summarizeToolOutput(report)).toEqual(summarizeToolOutput(report));
  });

  it('returns output that already fits unchanged', () => {
    const small = 'npm test\n\n> test\n\n3 passed\n';
    const summary = summarizeToolOutput(small);
    expect(summary.verbatim).toBe(true);
    expect(summary.summary).toBe(small);
    expect(summary.elidedLines).toBe(0);
    expect(summary.estimatedTokens.exact).toBe(false);
  });

  it('keeps failure messages, paths, counts and the exit code verbatim while shrinking a test report', () => {
    const report = testReport();
    const summary = summarizeToolOutput(report);
    expect(summary.kind).toBe('test');
    expect(summary.verbatim).toBe(false);
    expect(summary.summary.length).toBeLessThan(report.length / 4);
    for (const line of [
      '   AssertionError: expected "allowed" to be "refused"',
      '     at tests/gates/profiles.test.ts:88:21',
      '     expected: refused',
      '     received: allowed',
      '   Error: ENOENT: no such file or directory, open \'/work/repo/config/mcp-catalog.yaml\'',
      '     at tests/cli/mcp.test.ts:17:5',
      ' Test Files  2 failed | 24 passed (26)',
      '      Tests  2 failed | 523 passed (525)',
      'exit code 1',
      '> vitest run',
    ]) expect(summary.summary.split('\n')).toContain(line);
    // Every summary line is a line of the original or a bracketed count; nothing is rewritten.
    const original = new Set(report.split('\n'));
    for (const line of summary.summary.split('\n')) expect(original.has(line) || /^\[(… \d+ line\(s\) elided; see the full output|previous line repeated \d+ more time\(s\))\]$/.test(line)).toBe(true);
    expect(summary.summary).toMatch(/\[… \d+ line\(s\) elided; see the full output\]/);
    expect(summary.elidedLines).toBeGreaterThan(300);
    expect(summary.originalLines).toBe(report.split('\n').length);
  });

  it('collapses repeated lines with a count instead of dropping them', () => {
    const summary = summarizeToolOutput(testReport());
    expect(summary.summary).toContain('stderr | warning: deprecated option "legacy" is ignored\n[previous line repeated 29 more time(s)]');
  });

  it('respects the character budget and still keeps the counts', () => {
    const summary = summarizeToolOutput(testReport(), { maxChars: 1200 });
    expect(summary.summary.length).toBeLessThanOrEqual(1200 + 80);
    expect(summary.summary).toContain('      Tests  2 failed | 523 passed (525)');
  });

  it('summarises a large JSON document by shape and size without inventing values', () => {
    const document = JSON.stringify({ name: 'report', ok: false, items: Array.from({ length: 500 }, (_, index) => ({ id: index, path: `src/file-${index}.ts`, errors: [] })), nested: { deep: { deeper: { deepest: 1 } } } }, null, 2);
    const summary = summarizeToolOutput(document);
    expect(summary.kind).toBe('json');
    expect(summary.verbatim).toBe(false);
    expect(summary.summary).toContain(`JSON object{4}, ${Buffer.byteLength(document)} bytes`);
    expect(summary.summary).toContain('"items": array[500]');
    expect(summary.summary).toContain('"ok": false');
    expect(summary.summary).toContain('depth 4');
  });

  it('classifies plain logs and keeps their error lines and tail', () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `2026-10-19T05:00:${String(index % 60).padStart(2, '0')}Z info step ${index} ok`);
    lines.splice(1500, 0, 'ERROR: connection to registry.example refused (exit code 7)', 'warning: retrying in 5s');
    const text = lines.join('\n');
    expect(classifyToolOutput(text)).toBe('log');
    const summary = summarizeToolOutput(text);
    expect(summary.summary).toContain('ERROR: connection to registry.example refused (exit code 7)');
    expect(summary.summary).toContain('warning: retrying in 5s');
    expect(summary.summary).toContain(lines.at(-1)!);
    expect(summary.summary).toContain(lines[0]!);
    expect(summary.summary.length).toBeLessThan(5000);
  });

  it('writes the recovery pointer with the stored path and the full-output digest', () => {
    const pointer = recoveryPointer({ path: '/home/me/.code-conductor/runs/RUN-1/tool-output/E-1.json', sha256: 'ab'.repeat(32) });
    expect(pointer).toBe(`Full output: /home/me/.code-conductor/runs/RUN-1/tool-output/E-1.json (sha256 ${'ab'.repeat(32)}). The gate verdict comes from the exit status and the full output, not from this summary.`);
    expect(recoveryPointer({ path: 'p', sha256: 'd', truncated: true })).toContain('output beyond the capture bound was not stored');
  });
});
