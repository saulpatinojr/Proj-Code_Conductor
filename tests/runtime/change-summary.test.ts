import { describe, expect, it } from 'vitest';
import { shortList } from '../../packages/runtime/src/change-summary.js';

describe('shortList', () => {
  const shas = Array.from({ length: 12 }, (_, index) => `${String(index + 1).padStart(12, '0')}${'a'.repeat(28)}`);

  it('shortens one entry to twelve characters', () => {
    expect(shortList(shas.slice(0, 1))).toBe('000000000001');
  });

  it('separates two shortened entries with a comma and space', () => {
    expect(shortList(shas.slice(0, 2))).toBe('000000000001, 000000000002');
  });

  it('shows the first ten of twelve entries and counts the remaining two', () => {
    expect(shortList(shas)).toBe('000000000001, 000000000002, 000000000003, 000000000004, 000000000005, 000000000006, 000000000007, 000000000008, 000000000009, 000000000010, … (2 more)');
  });
});
