import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ContextOptimizer,
  estimateTokens,
  isSensitiveContextPath,
  minifyPayload,
} from '../../packages/context-optimizer/src/index.js';
import { DESCRIPTOR_LOCATION_SUPPORTED } from '../../packages/context-optimizer/src/checked-read.js';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('Context Optimizer', () => {
  describe('estimateTokens', () => {
    it('returns 0 for empty or whitespace content', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('   \n\t  ')).toBe(0);
    });

    it('returns a deliberately approximate character-based estimate', () => {
      const text = 'Hello world, this is a test payload for token estimation.';
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(30);
    });
  });

  describe('minifyPayload', () => {
    it('minifies valid JSON without changing data semantics in lossless mode', () => {
      const input = `{\n  "name": "code-conductor",\n  "version": "0.1.0",\n  "active": true\n}`;
      expect(minifyPayload(input, '.json')).toBe('{"name":"code-conductor","version":"0.1.0","active":true}');
    });

    it('preserves YAML comments and formatting in the default lossless mode', () => {
      const input = '# Security rationale\nname: test\n\n# Keep this requirement\nspec:\n  value: 42\n';
      expect(minifyPayload(input, '.yaml')).toBe(input);
    });

    it('only strips YAML comments when aggressive optimization is explicit', () => {
      const input = '# Top-level comment\nname: test\n# Another comment\n\nspec:\n  value: 42\n';
      const minified = minifyPayload(input, '.yaml', 'aggressive');
      expect(minified).not.toContain('# Top-level comment');
      expect(minified).not.toContain('# Another comment');
      expect(minified).toContain('name: test');
      expect(minified).toContain('spec:\n  value: 42');
    });

    it('only strips Terraform comments in aggressive mode', () => {
      const input = '# Provider configuration\nterraform {\n  // Required version\n  required_version = ">= 1.0.0"\n}\n';
      expect(minifyPayload(input, '.tf')).toBe(input);
      const aggressive = minifyPayload(input, '.tf', 'aggressive');
      expect(aggressive).not.toContain('# Provider configuration');
      expect(aggressive).not.toContain('// Required version');
      expect(aggressive).toContain('required_version = ">= 1.0.0"');
    });

    it('only removes closed Markdown HTML comments in aggressive mode', () => {
      const input = '# Title\n\n<!-- hidden requirement -->\n\nParagraph text.\n';
      expect(minifyPayload(input, '.md')).toBe(input);
      expect(minifyPayload(input, '.md', 'aggressive')).not.toContain('<!-- hidden requirement -->');
    });

    it('preserves unterminated Markdown comment input instead of truncating content', () => {
      const input = '# Title\n\n<!-- incomplete requirement\ncritical text\n';
      const aggressive = minifyPayload(input, '.md', 'aggressive');
      expect(aggressive).toContain('<!-- incomplete requirement');
      expect(aggressive).toContain('critical text');
    });

    it('handles repeated closed Markdown comments without regular-expression backtracking', () => {
      const input = `${Array.from({ length: 100 }, (_, index) => `<!-- comment ${index} -->`).join('\n')}\n# Keep me\n`;
      const aggressive = minifyPayload(input, '.md', 'aggressive');
      expect(aggressive).toBe('# Keep me');
    });
  });

  describe('sensitive path policy', () => {
    it('blocks secrets/state patterns while allowing templates', () => {
      expect(isSensitiveContextPath('.env')).toBe(true);
      expect(isSensitiveContextPath('ops/prod.tfstate')).toBe(true);
      expect(isSensitiveContextPath('certs/client.pem')).toBe(true);
      expect(isSensitiveContextPath('.env.example')).toBe(false);
      expect(isSensitiveContextPath('src/index.ts')).toBe(false);
    });
  });

  describe('ContextOptimizer workflow', () => {
    it('compresses content, records estimated telemetry, and allows roundtrip retrieval', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'cc-optimizer-'));
      const statsFile = join(tempDir, 'stats.json');

      try {
        const optimizer = new ContextOptimizer({ statsFile, allowedRoots: [tempDir] });
        const json = `{\n  "key1": "value1",\n  "key2": "value2",\n  "list": [1, 2, 3, 4, 5]\n}`;
        const result = optimizer.compress(json, { contentType: 'json', project: 'codex' });

        expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
        expect(result.mode).toBe('lossless');
        expect(result.tokenEstimateExact).toBe(false);
        expect(result.optimizedContent).toBe('{"key1":"value1","key2":"value2","list":[1,2,3,4,5]}');
        expect(optimizer.retrieve(result.contextId)).toBe(json);

        const stats = optimizer.getStats();
        expect(stats.requests.total).toBe(1);
        expect(stats.projects.codex).toBe(result.tokensSaved);
        expect(stats.estimation).toEqual({ exact: false, method: 'characters_divided_by_four' });

        const reloaded = new ContextOptimizer({ statsFile, allowedRoots: [tempDir] });
        expect(reloaded.getStats().requests.total).toBe(1);

        if (process.platform !== 'win32') {
          expect(mode(tempDir)).toBe(0o700);
          expect(mode(statsFile)).toBe(0o600);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // Reads succeed only where the opened file's location can be verified (checked-read.test.ts).
    it.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('reads only workspace-scoped files and preserves authoritative context by default', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'cc-optimizer-file-'));
      const testFile = join(tempDir, 'test.yaml');
      const statsFile = join(tempDir, 'stats.json');
      const input = '# Requirement: keep this comment\nkey: value\n\n';
      writeFileSync(testFile, input);

      try {
        const optimizer = new ContextOptimizer({ statsFile, allowedRoots: [tempDir] });
        const { content, result } = optimizer.readCompressedFile(testFile, 'claude');
        expect(content).toBe(input);
        expect(content).not.toContain('<context_block');
        expect(result.mode).toBe('lossless');

        const aggressive = optimizer.readCompressedFile(testFile, 'claude', 'aggressive');
        expect(aggressive.content).not.toContain('# Requirement');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('answers a missing path and an outside path alike, so paths elsewhere cannot be probed', () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-optimizer-probe-root-'));
      const outside = mkdtempSync(join(tmpdir(), 'cc-optimizer-probe-outside-'));
      writeFileSync(join(outside, 'exists.md'), 'x\n');
      try {
        const optimizer = new ContextOptimizer({ statsFile: join(root, 'stats.json'), allowedRoots: [root] });
        const message = (path: string) => { try { optimizer.readCompressedFile(path); return ''; } catch (error) { return (error as Error).message.replace(path, '<path>'); } };
        expect(message(join(outside, 'exists.md'))).toBe(message(join(outside, 'missing.md')));
        expect(message(join(root, 'missing.md'))).toMatch(/does not exist or is outside the allowed workspace roots/);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('blocks reads outside configured workspace roots', () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-optimizer-root-'));
      const outside = mkdtempSync(join(tmpdir(), 'cc-optimizer-outside-'));
      const outsideFile = join(outside, 'outside.md');
      writeFileSync(outsideFile, '# Outside\n');
      try {
        const optimizer = new ContextOptimizer({ statsFile: join(root, 'stats.json'), allowedRoots: [root] });
        expect(() => optimizer.readCompressedFile(outsideFile)).toThrow(/outside the allowed workspace roots/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('blocks sensitive files even when they are inside the workspace', () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-optimizer-sensitive-'));
      const secret = join(root, '.env');
      writeFileSync(secret, 'TOKEN=secret\n');
      try {
        const optimizer = new ContextOptimizer({ statsFile: join(root, 'stats.json'), allowedRoots: [root] });
        expect(() => optimizer.readCompressedFile(secret)).toThrow(/sensitive context file/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('blocks files above the configured size limit', () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-optimizer-size-'));
      const large = join(root, 'large.txt');
      writeFileSync(large, 'x'.repeat(32));
      try {
        const optimizer = new ContextOptimizer({ statsFile: join(root, 'stats.json'), allowedRoots: [root], maxFileBytes: 16 });
        expect(() => optimizer.readCompressedFile(large)).toThrow(/exceeds the 16 byte limit/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('refuses a hard link, which can make a file from outside appear inside the workspace', () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-optimizer-hardlink-root-'));
      const outside = mkdtempSync(join(tmpdir(), 'cc-optimizer-hardlink-outside-'));
      const secret = join(outside, 'private.txt');
      writeFileSync(secret, 'outside the workspace\n');
      linkSync(secret, join(root, 'notes.md'));
      try {
        const optimizer = new ContextOptimizer({ statsFile: join(root, 'stats.json'), allowedRoots: [root] });
        expect(() => optimizer.readCompressedFile(join(root, 'notes.md'))).toThrow(/more than one hard link/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting on it', () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-optimizer-fifo-'));
      execFileSync('mkfifo', [join(root, 'pipe.md')]);
      try {
        const optimizer = new ContextOptimizer({ statsFile: join(root, 'stats.json'), allowedRoots: [root] });
        expect(() => optimizer.readCompressedFile(join(root, 'pipe.md'))).toThrow(/not a regular file/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.runIf(DESCRIPTOR_LOCATION_SUPPORTED)('resolves symlinks before enforcing the workspace boundary', () => {
      const root = mkdtempSync(join(tmpdir(), 'cc-optimizer-symlink-root-'));
      const outside = mkdtempSync(join(tmpdir(), 'cc-optimizer-symlink-outside-'));
      const outsideFile = join(outside, 'outside.txt');
      const linkDir = join(root, 'links');
      const link = join(linkDir, 'outside.txt');
      mkdirSync(linkDir);
      writeFileSync(outsideFile, 'outside\n');
      symlinkSync(outsideFile, link);
      try {
        const optimizer = new ContextOptimizer({ statsFile: join(root, 'stats.json'), allowedRoots: [root] });
        expect(() => optimizer.readCompressedFile(link)).toThrow(/outside the allowed workspace roots/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
