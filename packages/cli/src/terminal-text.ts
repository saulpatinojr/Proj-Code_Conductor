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

/**
 * JSON for a terminal or a pipe. It is still valid JSON with the same value, but the
 * characters JSON leaves raw that can hide or reorder text on a terminal (DEL, C1
 * controls, format characters such as bidirectional overrides, line and paragraph
 * separators) are written as \uXXXX escapes.
 */
export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => [...Array(character.length).keys()].map((index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''));
}
