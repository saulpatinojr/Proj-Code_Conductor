import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const cc = (...args: string[]) => JSON.parse(spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'mcp', ...args], { encoding: 'utf8' }).stdout) as { note: string; servers: Array<Record<string, unknown>> };

describe('cc mcp (I08, #40)', () => {
  it('lists selection only, with what a native client would be configured with', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
    temps.push(repo);
    writeFileSync(join(repo, 'main.tf'), '');
    const listed = cc('--repo', repo, '--profiles', 'azure,research-automated');
    expect(listed.note).toContain('starts no MCP server and grants no authority');
    const azure = listed.servers.find((server) => server.id === 'azure');
    expect(azure).toMatchObject({ official: true, maturity: 'preview', defaultAccess: 'read', separatelyBilledApi: false });
    expect(azure?.launch).toEqual(expect.arrayContaining([expect.stringMatching(/^@azure\/mcp@\d/)]));
    // Separately billed servers appear only when asked for.
    expect(listed.servers.some((server) => server.id === 'perplexity')).toBe(false);
    expect(cc('--repo', repo, '--profiles', 'research-automated', '--allow-api').servers.find((server) => server.id === 'perplexity')).toMatchObject({ separatelyBilledApi: true });
  });

  it('lists no server whose launch path exists only in a source checkout', () => {
    const listed = cc('--profiles', 'context-optimization,token-reduction');
    expect(listed.servers).toEqual([]);
  });
});
