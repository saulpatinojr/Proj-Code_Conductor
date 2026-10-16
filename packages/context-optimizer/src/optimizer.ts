import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { readCheckedFile, requireDescriptorLocation } from './checked-read.js';

export type OptimizationMode = 'lossless' | 'aggressive';

export interface OptimizationStats {
  requestsTotal: number;
  tokensOriginal: number;
  tokensOptimized: number;
  tokensSaved: number;
  overheadMsTotal: number;
  projects: Record<string, number>;
  history: Array<{
    timestampUtc: string;
    project: string;
    tokensOriginal: number;
    tokensOptimized: number;
    tokensSaved: number;
    overheadMs: number;
    mode: OptimizationMode;
  }>;
}

export interface OptimizationResult {
  contextId: string;
  originalTokens: number;
  optimizedTokens: number;
  tokensSaved: number;
  savingsPercent: number;
  overheadMs: number;
  optimizedContent: string;
  mode: OptimizationMode;
  tokenEstimateExact: false;
}

export interface CompressOptions {
  contentType?: string;
  project?: string;
  mode?: OptimizationMode;
}

export interface ContextOptimizerOptions {
  statsFile?: string;
  maxCacheEntries?: number;
  cacheTtlMs?: number;
  allowedRoots?: string[];
  maxFileBytes?: number;
}

export function estimateTokens(content: string): number {
  if (!content) return 0;
  // Deliberately approximate. This metric is for relative savings telemetry, not billing.
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function removeClosedHtmlComments(content: string): string {
  let cursor = 0;
  let output = '';

  while (cursor < content.length) {
    const start = content.indexOf('<!--', cursor);
    if (start < 0) {
      output += content.slice(cursor);
      break;
    }

    output += content.slice(cursor, start);
    const end = content.indexOf('-->', start + 4);
    if (end < 0) {
      // Preserve malformed/unterminated input rather than truncating potentially
      // meaningful instructions in the aggressive path.
      output += content.slice(start);
      break;
    }
    cursor = end + 3;
  }

  return output;
}

export function minifyPayload(content: string, typeOrExt: string, mode: OptimizationMode = 'lossless'): string {
  if (!content) return '';
  const ext = (typeOrExt.startsWith('.') ? typeOrExt : `.${typeOrExt}`).toLowerCase();

  // JSON whitespace is not semantically significant, so compacting a valid JSON
  // document remains safe in the conservative mode.
  if (ext === '.json') {
    try {
      return JSON.stringify(JSON.parse(content));
    } catch {
      return mode === 'aggressive' ? content.replace(/\s+/g, ' ').trim() : content;
    }
  }

  // Comments can carry requirements, suppressions, security rationale, and agent
  // instructions. Preserve them unless aggressive optimization is explicitly requested.
  if (mode === 'lossless') return content;

  if (ext === '.yaml' || ext === '.yml') {
    return content
      .split(/\r?\n/)
      .filter((line) => !/^\s*#(?!!)/.test(line))
      .join('\n')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  }

  if (ext === '.tf' || ext === '.hcl') {
    return content
      .split(/\r?\n/)
      .filter((line) => !/^\s*(#|\/\/)/.test(line))
      .join('\n')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  }

  if (ext === '.md') {
    return removeClosedHtmlComments(content)
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function isSensitiveContextPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const leaf = normalized.split('/').at(-1) ?? normalized;
  if (leaf === '.env.example' || leaf === '.env.template' || leaf === 'credentials.example') return false;
  if (leaf === '.env' || leaf.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(leaf)) return true;
  if (leaf === 'terraform.tfstate' || leaf.endsWith('.tfstate') || leaf.endsWith('.tfstate.backup')) return true;
  if (normalized.includes('/.terraform/')) return true;
  if (/^(credentials|credentials\..+|id_rsa|id_ed25519)$/.test(leaf)) return true;
  return false;
}

function canonicalRoot(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function pathWithinRoot(path: string, root: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const candidate = normalize(path);
  const base = normalize(root);
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

export class ContextOptimizer {
  private readonly statsFile: string;
  private readonly cache = new Map<string, { content: string; createdAt: number }>();
  private readonly maxCacheEntries: number;
  private readonly cacheTtlMs: number;
  private readonly allowedRoots: string[];
  private readonly maxFileBytes: number;
  private stats: OptimizationStats;

  constructor(options: ContextOptimizerOptions = {}) {
    this.maxCacheEntries = options.maxCacheEntries ?? 500;
    this.cacheTtlMs = options.cacheTtlMs ?? 3600000;
    this.allowedRoots = (options.allowedRoots ?? [process.cwd()]).map(canonicalRoot);
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
    this.statsFile =
      options.statsFile ??
      join(process.env.CODE_CONDUCTOR_HOME || join(homedir(), '.code-conductor'), 'context-optimization-stats.json');

    this.stats = {
      requestsTotal: 0,
      tokensOriginal: 0,
      tokensOptimized: 0,
      tokensSaved: 0,
      overheadMsTotal: 0,
      projects: {
        codex: 0,
        claude: 0,
        github: 0,
        copilot: 0,
        antigravity: 0,
        vscode: 0,
        cli: 0,
      },
      history: [],
    };

    this.loadStats();
  }

  compress(content: string, options: CompressOptions = {}): OptimizationResult {
    const started = performance.now();
    const project = (options.project || 'vscode').toLowerCase();
    const contentType = options.contentType || 'text';
    const mode = options.mode ?? 'lossless';

    const optimized = minifyPayload(content, contentType, mode);
    const overheadMs = Math.round(performance.now() - started);

    const originalTokens = estimateTokens(content);
    const optimizedTokens = estimateTokens(optimized);
    const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
    const savingsPercent = originalTokens > 0 ? Math.round((tokensSaved / originalTokens) * 10000) / 100 : 0;

    const contextId = randomUUID();
    this.pruneCache();
    this.cache.set(contextId, { content, createdAt: Date.now() });

    this.recordStats(project, originalTokens, optimizedTokens, tokensSaved, overheadMs, mode);

    return {
      contextId,
      originalTokens,
      optimizedTokens,
      tokensSaved,
      savingsPercent,
      overheadMs,
      optimizedContent: optimized,
      mode,
      tokenEstimateExact: false,
    };
  }

  retrieve(contextId: string): string | undefined {
    const entry = this.cache.get(contextId);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.cacheTtlMs) {
      this.cache.delete(contextId);
      return undefined;
    }
    return entry.content;
  }

  readCompressedFile(filePath: string, project = 'vscode', mode: OptimizationMode = 'lossless'): { content: string; result: OptimizationResult } {
    const safePath = this.resolveAllowedFile(filePath);
    const raw = readCheckedFile(safePath, filePath, this.maxFileBytes);
    const ext = extname(safePath);
    const result = this.compress(raw, { contentType: ext, project, mode });
    return { content: result.optimizedContent, result };
  }

  getStats(): {
    requests: { total: number };
    tokens: { original: number; optimized: number; saved: number; savingsPercent: number };
    estimation: { exact: false; method: 'characters_divided_by_four' };
    overhead: { averageMs: number; totalMs: number };
    projects: Record<string, number>;
    history: OptimizationStats['history'];
    cache: { entries: number };
  } {
    const totalOriginal = this.stats.tokensOriginal;
    const totalSaved = this.stats.tokensSaved;
    const requests = this.stats.requestsTotal;
    const overheadTotal = this.stats.overheadMsTotal;

    const savingsPercent = totalOriginal > 0 ? Math.round((totalSaved / totalOriginal) * 10000) / 100 : 0;
    const averageMs = requests > 0 ? Math.round((overheadTotal / requests) * 100) / 100 : 0;

    return {
      requests: { total: requests },
      tokens: {
        original: totalOriginal,
        optimized: this.stats.tokensOptimized,
        saved: totalSaved,
        savingsPercent,
      },
      estimation: { exact: false, method: 'characters_divided_by_four' },
      overhead: { averageMs, totalMs: overheadTotal },
      projects: { ...this.stats.projects },
      history: [...this.stats.history],
      cache: { entries: this.cache.size },
    };
  }

  private resolveAllowedFile(filePath: string): string {
    requireDescriptorLocation(filePath);
    // One answer for a path that does not exist and for one outside the roots, so a caller
    // (an MCP client, for example) cannot learn which paths exist elsewhere on the machine.
    let canonical: string | undefined;
    try { canonical = realpathSync(resolve(filePath)); } catch { canonical = undefined; }
    if (!canonical || !this.allowedRoots.some((root) => pathWithinRoot(canonical, root))) {
      throw new Error(`Context file does not exist or is outside the allowed workspace roots: ${filePath}`);
    }
    if (isSensitiveContextPath(canonical)) {
      throw new Error(`Sensitive context file is blocked by policy: ${filePath}`);
    }
    const stat = statSync(canonical);
    if (!stat.isFile()) throw new Error(`Context path is not a regular file: ${filePath}`);
    if (stat.size > this.maxFileBytes) {
      throw new Error(`Context file exceeds the ${this.maxFileBytes} byte limit: ${filePath}`);
    }
    return canonical;
  }

  private recordStats(
    project: string,
    originalTokens: number,
    optimizedTokens: number,
    tokensSaved: number,
    overheadMs: number,
    mode: OptimizationMode,
  ): void {
    this.stats.requestsTotal += 1;
    this.stats.tokensOriginal += originalTokens;
    this.stats.tokensOptimized += optimizedTokens;
    this.stats.tokensSaved += tokensSaved;
    this.stats.overheadMsTotal += overheadMs;

    this.stats.projects[project] = (this.stats.projects[project] ?? 0) + tokensSaved;
    this.stats.history.push({
      timestampUtc: new Date().toISOString(),
      project,
      tokensOriginal: originalTokens,
      tokensOptimized: optimizedTokens,
      tokensSaved,
      overheadMs,
      mode,
    });

    if (this.stats.history.length > 200) this.stats.history.shift();
    this.saveStats();
  }

  private pruneCache(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache.entries()) {
      if (now - entry.createdAt > this.cacheTtlMs) this.cache.delete(id);
    }
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  private loadStats(): void {
    if (!existsSync(this.statsFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.statsFile, 'utf8')) as Partial<OptimizationStats>;
      if (typeof data.requestsTotal === 'number') this.stats.requestsTotal = data.requestsTotal;
      if (typeof data.tokensOriginal === 'number') this.stats.tokensOriginal = data.tokensOriginal;
      if (typeof data.tokensOptimized === 'number') this.stats.tokensOptimized = data.tokensOptimized;
      if (typeof data.tokensSaved === 'number') this.stats.tokensSaved = data.tokensSaved;
      if (typeof data.overheadMsTotal === 'number') this.stats.overheadMsTotal = data.overheadMsTotal;
      if (typeof data.projects === 'object' && data.projects !== null) this.stats.projects = { ...this.stats.projects, ...data.projects };
      if (Array.isArray(data.history)) {
        this.stats.history = data.history.slice(-200).map((entry) => ({ ...entry, mode: entry.mode === 'aggressive' ? 'aggressive' : 'lossless' }));
      }
    } catch {
      // Corrupt local telemetry must never block task execution.
    }
  }

  private saveStats(): void {
    try {
      const dir = dirname(this.statsFile);
      ensurePrivateDirectory(dir);
      writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(this.statsFile, 0o600);
    } catch {
      // Metrics persistence is best-effort and never part of task correctness.
    }
  }
}
