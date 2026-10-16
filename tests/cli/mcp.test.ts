import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
const cc = (...args: string[]) => {
  const run = spawnSync(process.execPath, [resolve('packages/cli/dist/index.js'), 'mcp', ...args], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as { note: string; servers: Array<Record<string, unknown>> };
};

describe('cc mcp (I08, #40)', () => {
  it('lists selection only, with what a native client would be configured with', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
    temps.push(repo);
    const listed = cc('--repo', repo, '--profiles', 'azure,aws,research-automated');
    expect(listed.note).toContain('starts no MCP server and grants no authority');
    const azure = listed.servers.find((server) => server.id === 'azure');
    expect(azure).toMatchObject({ official: true, maturity: 'preview', defaultAccess: 'read', separatelyBilledApi: false });
    expect(azure?.launch).toEqual(expect.arrayContaining([expect.stringMatching(/^@azure\/mcp@\d/)]));
    expect(listed.servers.find((server) => server.id === 'azure')).toMatchObject({ provenance: 'vendor_official', transport: 'stdio' });
    // A remote endpoint, and a template whose parts a person fills in, are shown as such.
    expect(listed.servers.find((server) => server.id === 'microsoft-learn')?.endpoint).toMatch(/^https:\/\//);
    const aws = listed.servers.find((server) => server.id === 'aws');
    expect(aws?.endpointTemplate).toMatch(/^https:\/\/.*<region>/);
    expect(aws?.endpoint).toBeUndefined();
    // Separately billed servers appear only when asked for.
    expect(listed.servers.some((server) => server.id === 'perplexity')).toBe(false);
    expect(cc('--repo', repo, '--profiles', 'research-automated', '--allow-api').servers.find((server) => server.id === 'perplexity')).toMatchObject({ separatelyBilledApi: true });
  });

  it('lists no server whose launch path exists only in a source checkout', () => {
    const listed = cc('--profiles', 'context-optimization,token-reduction');
    expect(listed.servers).toEqual([]);
  });
});
