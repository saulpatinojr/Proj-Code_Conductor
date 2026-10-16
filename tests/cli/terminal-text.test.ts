import { describe, expect, it } from 'vitest';
import { terminalText } from '../../packages/cli/src/terminal-text.js';

describe('terminal rendering of handoff prompts', () => {
  it('keeps line breaks and readable text but neutralizes terminal control', () => {
    const plain = terminalText('Objective: Fix the caf\u00e9 bug\nRole: builder');
    expect(plain).toEqual({ text: 'Objective: Fix the caf\u00e9 bug\nRole: builder', replaced: false });
    const hostile = terminalText('Objective: x\x1b]52;c;ZXZpbA==\x07\u202Eevil\rhidden\nRole: builder');
    expect(hostile.replaced).toBe(true);
    expect(hostile.text).not.toMatch(/[\x1b\x07\u202E\r]/u);
    expect(hostile.text.split('\n')).toHaveLength(2);
  });
});
