import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readBoundedFile } from '@code-conductor/policy/bounded-read';

export interface PackRecord { reference: string; name: string; commit?: string; version?: string; state: 'declared' | 'locked' | 'mismatch' | 'unsupported'; projections: string[] }
export interface PackInventory { manifestSha256?: string; lockSha256?: string; apmVersion?: string; targets: string[]; packs: PackRecord[]; diagnostics: string[] }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function strings(value: unknown): string[] { return Array.isArray(value) && value.length <= 1000 && value.every((item) => typeof item === 'string' && item.length <= 1000) ? value : []; }
function document(root: string, name: string): { value: Record<string, unknown>; sha256: string } | undefined {
  const path = join(root, name);
  if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
  const bytes = readBoundedFile(path, 1048576);
  const value: unknown = parse(bytes.toString('utf8'), { maxAliasCount: 20, logLevel: 'error' });
  if (!object(value)) throw new Error(`${name} must contain an object.`);
  return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
}
/** Bounded local metadata only. A lock or matching pin is never an integrity audit. */
export function packInventory(root: string): PackInventory {
  const result: PackInventory = { targets: [], packs: [], diagnostics: [] };
  try {
    const manifest = document(root, 'apm.yml'); const lock = document(root, 'apm.lock.yaml');
    result.manifestSha256 = manifest?.sha256; result.lockSha256 = lock?.sha256;
    const targets = manifest?.value.targets;
    if (targets !== undefined && (!Array.isArray(targets) || strings(targets).length !== targets.length)) throw new Error('Unsupported target list.');
    result.targets = strings(targets);
    if (result.targets.some((target) => !['copilot', 'claude', 'codex', 'kiro', 'antigravity', 'agent-skills'].includes(target))) throw new Error('Unsupported target.');
    result.apmVersion = typeof lock?.value.apm_version === 'string' && /^\d+\.\d+\.\d+$/.test(lock.value.apm_version) && lock.value.apm_version.length < 40 ? lock.value.apm_version : undefined;
    if (lock && lock.value.lockfile_version !== '1') throw new Error('Unsupported lock format.');
    const dependencies = manifest?.value.dependencies;
    if (dependencies !== undefined && !object(dependencies)) throw new Error('Unsupported dependencies.');
    const declared = object(dependencies) ? dependencies.apm : undefined;
    if (declared !== undefined && (!Array.isArray(declared) || strings(declared).length !== declared.length)) throw new Error('Unsupported manifest dependency list.');
    const locked = lock?.value.dependencies;
    if (locked !== undefined && (!Array.isArray(locked) || locked.length > 1000 || !locked.every(object))) throw new Error('Unsupported lock dependency list.');
    for (const reference of strings(declared)) {
      const match = /^hybridcloudworks\/Proj-AgentPacks\/([a-z0-9-]+)#([a-f0-9]{40})$/i.exec(reference);
      if (!match) { result.packs.push({ reference: 'Unsupported reference (inspect apm.yml)', name: 'Unsupported package reference', state: 'unsupported', projections: [] }); continue; }
      const candidates = (locked as Record<string, unknown>[] | undefined)?.filter((item) => item.virtual_path === match[1]) ?? [];
      if (candidates.length > 1) throw new Error('Ambiguous lock association.');
      const entry = candidates[0];
      const mirror = entry?.host === 'github.com' && typeof entry.repo_url === 'string' && entry.repo_url.toLowerCase() === 'hybridcloudworks/proj-agentpacks' && typeof entry.materialization_repo_url === 'string' && entry.materialization_repo_url.toLowerCase() === 'hybridcloudworks/proj-agentpacks';
      const commit = typeof entry?.resolved_commit === 'string' && /^[a-f0-9]{40}$/.test(entry.resolved_commit) ? entry.resolved_commit : undefined;
      const projections = strings(entry?.deployed_files);
      if (entry?.deployed_files !== undefined && (!Array.isArray(entry.deployed_files) || projections.length !== entry.deployed_files.length)) throw new Error('Unsupported projection list.');
      if (projections.some((path) => path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(path))) throw new Error('Unsafe projection path.');
      result.packs.push({ reference, name: match[1]!, ...(commit ? { commit } : {}), ...(typeof entry?.version === 'string' ? { version: entry.version } : {}), state: !entry ? 'declared' : mirror && commit === match[2]!.toLowerCase() ? 'locked' : 'mismatch', projections });
    }
    if (lock && !manifest) result.diagnostics.push('Lock exists without apm.yml. No pack association inferred.');
    if (lock && result.apmVersion !== '0.33.0') result.diagnostics.push('Lock was not produced by the supported APM 0.33.0.');
    if (result.packs.some((item) => item.state === 'unsupported')) result.diagnostics.push('Only reviewed Agent Packs mirror references pinned to a full commit are supported by this view.');
  } catch { result.diagnostics.push('APM metadata could not be read safely. Check syntax, symlinks and the 1 MiB file limit.'); }
  return result;
}

/** Plain text by design: package-controlled values cannot inject editor Markdown links. */
export function packInventoryText(root: string, inventory = packInventory(root)): string {
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 1000);
  return [
    'Code Conductor pack inventory (read-only)', `Repository: ${clean(root)}`,
    `Manifest SHA-256: ${inventory.manifestSha256 ?? 'absent'}`, `Lock SHA-256: ${inventory.lockSha256 ?? 'absent'}`,
    `Lock APM version: ${inventory.apmVersion ?? 'unknown'}`, `Targets: ${inventory.targets.map(clean).join(', ') || 'none'}`,
    'Audit state: unknown; lock presence and matching pins do not establish integrity or execution authority.',
    ...inventory.packs.flatMap((pack) => ['', `Pack: ${clean(pack.name)} (${pack.state})`, `Declared: ${clean(pack.reference)}`, `Locked commit: ${pack.commit ?? 'none'}`, `Version: ${clean(pack.version ?? 'unknown')}`, 'Recorded projection paths (not a proposed install diff):', ...pack.projections.map((path) => `  ${clean(path)}`)]),
    ...inventory.diagnostics.map((message) => `Diagnostic: ${clean(message)}`),
    '', 'No install, audit, hook, provider or MCP process was started. No files were written.',
    'Installation/update/removal still requires an exact projection diff, conflict checks and action-specific approval in a supported workflow.',
  ].join('\n');
}
