import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { parse } from 'yaml';

/**
 * Read-only inventory of provider-native agents and skills (ADR 0011).
 *
 * ADR 0009 requires provider-native subagents/skills to stay discoverable and
 * W-003 asks for that to be validated. This module only reads files: it never
 * installs, rewrites, or deletes anything, never follows symlinks, and treats
 * `apm audit` as the authority on policy. `managedByApm` is informational.
 */

export type NativeEcosystem = 'claude' | 'copilot' | 'codex' | 'kiro' | 'agent-skills';
export type NativeKind = 'agent' | 'skill';
export type NativeScope = 'project' | 'user';

export interface NativeInventoryEntry {
  ecosystem: NativeEcosystem;
  kind: NativeKind;
  scope: NativeScope;
  name: string;
  /** Project scope: repository-relative POSIX path. User scope: absolute path. */
  path: string;
  /** True when the project file is recorded in apm.lock.yaml `local_deployed_files`. Always false for user scope. */
  managedByApm: boolean;
}

export interface NativeInventory {
  entries: NativeInventoryEntry[];
  lockPresent: boolean;
  /** Project-scope entries not recorded in the APM lockfile (informational; `apm audit` is authoritative). */
  unmanagedProjectPaths: string[];
  truncated: boolean;
}

interface Location {
  ecosystem: NativeEcosystem;
  kind: NativeKind;
  projectDir?: string;
  userDir?: string;
}

const LOCATIONS: Location[] = [
  { ecosystem: 'claude', kind: 'agent', projectDir: '.claude/agents', userDir: '.claude/agents' },
  { ecosystem: 'copilot', kind: 'agent', projectDir: '.github/agents', userDir: '.copilot/agents' },
  { ecosystem: 'codex', kind: 'agent', projectDir: '.codex/agents', userDir: '.codex/agents' },
  { ecosystem: 'kiro', kind: 'agent', projectDir: '.kiro/agents', userDir: '.kiro/agents' },
  { ecosystem: 'claude', kind: 'skill', projectDir: '.claude/skills', userDir: '.claude/skills' },
  { ecosystem: 'copilot', kind: 'skill', projectDir: '.github/skills', userDir: '.copilot/skills' },
  { ecosystem: 'agent-skills', kind: 'skill', projectDir: '.agents/skills', userDir: '.agents/skills' },
  { ecosystem: 'kiro', kind: 'skill', projectDir: '.kiro/skills', userDir: '.kiro/skills' },
];

const MAX_FILES = 5000;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function walkFiles(dir: string, budget: { remaining: number }): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (budget.remaining <= 0) return;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        out.push(full);
        budget.remaining -= 1;
      }
    }
  };
  visit(dir);
  return out;
}

/**
 * The first top-level `name:` line in a file's front matter with a usable value: plain or
 * quoted, on that line. A value holding another quote or a `#` (a YAML comment) is skipped,
 * not guessed at. Read line by line: these files come from whatever repository is open,
 * and the regular expression this replaces took cubic time on a long run of spaces.
 */
function frontmatterName(text: string): string | undefined {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return undefined;
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return undefined;
  for (const line of normalized.slice(4, end).split('\n')) {
    if (!line.startsWith('name:')) continue;
    let value = line.slice('name:'.length).trim();
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1);
    if (value.endsWith('"') || value.endsWith("'")) value = value.slice(0, -1);
    value = value.trim();
    if (value && !/["'#]/.test(value)) return value;
  }
  return undefined;
}

function tomlName(text: string): string | undefined {
  return text.match(/^name\s*=\s*"([^"\n]+)"/m)?.[1]?.trim() || undefined;
}

const SMALL_FILE_BYTES = 256 * 1024;

/** Read a small text file through one descriptor: the size checked is the size read, and no final symlink is followed. */
function readSmall(path: string): string {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return ''; }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > SMALL_FILE_BYTES) return '';
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length;) {
      read = readSync(descriptor, buffer, length, buffer.length - length, null);
      length += read;
    }
    return length > stat.size ? '' : buffer.subarray(0, length).toString('utf8');
  } catch {
    return '';
  } finally { closeSync(descriptor); }
}

function agentEntryName(file: string, ecosystem: NativeEcosystem): string | undefined {
  const text = readSmall(file);
  if (ecosystem === 'codex') return file.endsWith('.toml') ? tomlName(text) ?? basename(file, '.toml') : undefined;
  if (!file.endsWith('.md')) return undefined;
  return frontmatterName(text) ?? basename(file).replace(/\.agent\.md$|\.md$/, '');
}

/** Project paths APM recorded as deployed (`local_deployed_files`). */
export function apmLockDeployedFiles(root: string): Set<string> | undefined {
  const lockPath = join(root, 'apm.lock.yaml');
  if (!existsSync(lockPath)) return undefined;
  const parsed = parse(readFileSync(lockPath, 'utf8')) as { local_deployed_files?: unknown } | null;
  const files = Array.isArray(parsed?.local_deployed_files) ? parsed.local_deployed_files : [];
  return new Set(files.filter((value): value is string => typeof value === 'string').map((value) => value.replaceAll('\\', '/')));
}

export function inventoryNativeCustomizations(root: string, home: string = homedir()): NativeInventory {
  const deployed = apmLockDeployedFiles(root);
  const budget = { remaining: MAX_FILES };
  const entries: NativeInventoryEntry[] = [];

  const scan = (location: Location, scope: NativeScope, base: string, dirRel: string | undefined): void => {
    if (!dirRel) return;
    const dir = join(base, dirRel);
    if (!existsSync(dir)) return;
    for (const file of walkFiles(dir, budget)) {
      let name: string | undefined;
      if (location.kind === 'skill') {
        if (basename(file) !== 'SKILL.md') continue;
        name = frontmatterName(readSmall(file)) ?? basename(join(file, '..'));
      } else {
        name = agentEntryName(file, location.ecosystem);
      }
      if (!name) continue;
      const path = scope === 'project' ? toPosix(relative(root, file)) : file;
      entries.push({
        ecosystem: location.ecosystem,
        kind: location.kind,
        scope,
        name,
        path,
        managedByApm: scope === 'project' && Boolean(deployed?.has(path)),
      });
    }
  };

  for (const location of LOCATIONS) {
    scan(location, 'project', root, location.projectDir);
    if (home && join(home, location.userDir ?? '') !== join(root, location.projectDir ?? '')) scan(location, 'user', home, location.userDir);
  }

  return {
    entries,
    lockPresent: deployed !== undefined,
    unmanagedProjectPaths: deployed ? entries.filter((entry) => entry.scope === 'project' && !entry.managedByApm).map((entry) => entry.path) : [],
    truncated: budget.remaining <= 0,
  };
}
