import { printable } from '@code-conductor/runtime';

/**
 * Multi-line untrusted text (for example a handoff prompt built from an imported task)
 * for display on a terminal: line breaks are kept, while control, format and
 * line-separator characters inside each line are replaced so the text cannot drive the
 * terminal. `replaced` says whether the shown text differs from the exact bytes.
 */
export function terminalText(text: string): { text: string; replaced: boolean } {
  const lines = text.split('\n');
  const shown = lines.map((line) => printable(line, Number.MAX_SAFE_INTEGER, false));
  return { text: shown.join('\n'), replaced: shown.some((line, index) => line !== lines[index]) };
}
