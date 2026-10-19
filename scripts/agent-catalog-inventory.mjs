#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.yml', '.yaml', '.json', '.jsonc', '.toml', '.ini', '.cfg', '.ps1', '.py', '.sh', '.js', '.mjs', '.cjs', '.ts', '.tsx']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // The lookbehind starts a match only where trailing blanks begin (linear, not quadratic).
    .map((line) => line.replace(/(?<![ \t])[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstHeading(text) {
  // The rest of the line, trimmed below: `(.+?)\s*$` scanned trailing blanks once per character.
  const match = text.match(/^#\s+(.+)/m);
  return match?.[1]?.trim();
}

function frontmatterKeys(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return [];
  return [...new Set(normalized.slice(4, end).split('\n').map((line) => line.match(/^([A-Za-z0-9_-]+)\s*:/)?.[1]).filter(Boolean))].sort();
}

function classificationHints(relativePath, text) {
  const lower = relativePath.toLowerCase();
  const file = basename(lower);
  const hints = [];
  if (file === 'skill.md' || lower.includes('/skills/') || lower.includes('\\skills\\')) hints.push('skill');
  if (file.endsWith('.agent.md') || lower.includes('/agents/') || lower.includes('\\agents\\') || /\bagent\b/.test(file)) hints.push('agent');
  if (/instruction/.test(file) || lower.includes('/instructions/') || lower.includes('\\instructions\\')) hints.push('instruction');
  if (/prompt/.test(file) || lower.includes('/prompts/') || lower.includes('\\prompts\\')) hints.push('prompt');
  if (/hook/.test(file) || lower.includes('/hooks/') || lower.includes('\\hooks\\')) hints.push('hook');
  if (/mcp/.test(file) || lower.includes('/mcp/') || lower.includes('\\mcp\\')) hints.push('mcp');
  if (/readme|reference|docs?\//.test(lower)) hints.push('reference');
  if (text && /(^|\n)name\s*:\s*.+agent/im.test(text.slice(0, 4000))) hints.push('agent');
  return [...new Set(hints)].sort();
}

function posixRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function collectPaths(root, outPath) {
  const paths = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (path === outPath) continue;
      if (entry.isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  walk(root);
  return paths;
}

function readRegularFile(path) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return undefined; }
  try {
    if (!fstatSync(descriptor).isFile()) return undefined;
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

export function buildInventory(sourceRoot, outputPath) {
  const root = realpathSync(resolve(sourceRoot));
  const out = outputPath ? resolve(outputPath) : undefined;
  if (out) {
    const outputRelative = relative(root, out);
    const outputInsideSource = outputRelative === '' || (outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`));
    if (outputInsideSource) throw new Error('Refusing to write the inventory ledger inside the immutable source corpus. Choose --out outside --source.');
  }
  const exactSeen = new Map();
  const normalizedSeen = new Map();
  const entries = [];

  for (const path of collectPaths(root, out)) {
    const stat = lstatSync(path);
    const sourcePath = posixRelative(root, path);

    if (stat.isSymbolicLink()) {
      entries.push({
        sourcePath,
        kind: 'symlink',
        bytes: stat.size,
        sha256: null,
        normalizedSha256: null,
        title: null,
        frontmatterKeys: [],
        classificationHints: [],
        exactDuplicateOf: null,
        normalizedDuplicateOf: null,
        disposition: 'manual_review',
        canonicalDestinations: [],
        reviewState: 'unreviewed',
        uniqueRequirementsPreserved: [],
        notes: ['Symlink was recorded but not followed or hashed.'],
      });
      continue;
    }

    if (!stat.isFile()) continue;
    // Read through one descriptor opened without following a symlink, so a file swapped
    // for a link after the lstat above is refused rather than followed and hashed.
    const bytes = readRegularFile(path);
    if (!bytes) continue;
    const digest = sha256(bytes);
    const extension = extname(path).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(extension) || basename(path).toLowerCase() === 'codeowners';
    const text = isText ? bytes.toString('utf8') : '';
    const normalizedDigest = isText ? sha256(Buffer.from(normalizedText(text), 'utf8')) : null;
    const exactDuplicateOf = exactSeen.get(digest) ?? null;
    const normalizedDuplicateOf = normalizedDigest && normalizedSeen.has(normalizedDigest) && normalizedSeen.get(normalizedDigest) !== sourcePath
      ? normalizedSeen.get(normalizedDigest)
      : null;

    if (!exactSeen.has(digest)) exactSeen.set(digest, sourcePath);
    if (normalizedDigest && !normalizedSeen.has(normalizedDigest)) normalizedSeen.set(normalizedDigest, sourcePath);

    entries.push({
      sourcePath,
      kind: 'file',
      bytes: stat.size,
      sha256: digest,
      normalizedSha256: normalizedDigest,
      title: isText ? firstHeading(text) ?? null : null,
      frontmatterKeys: isText ? frontmatterKeys(text) : [],
      classificationHints: isText ? classificationHints(sourcePath, text) : [],
      exactDuplicateOf,
      normalizedDuplicateOf: exactDuplicateOf ? null : normalizedDuplicateOf,
      disposition: 'pending',
      canonicalDestinations: [],
      reviewState: 'unreviewed',
      uniqueRequirementsPreserved: [],
      notes: isText ? [] : ['Binary or unrecognized file type was hashed but not text-inspected.'],
    });
  }

  const summary = {
    files: entries.filter((entry) => entry.kind === 'file').length,
    symlinks: entries.filter((entry) => entry.kind === 'symlink').length,
    exactDuplicates: entries.filter((entry) => entry.exactDuplicateOf).length,
    normalizedDuplicateCandidates: entries.filter((entry) => entry.normalizedDuplicateOf).length,
    pendingReview: entries.filter((entry) => entry.reviewState === 'unreviewed').length,
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: basename(root),
    sourceRootSha256: sha256(Buffer.from(entries.map((entry) => `${entry.sourcePath}\0${entry.sha256 ?? 'symlink'}\n`).join(''), 'utf8')),
    rules: {
      originalsModified: false,
      symlinksFollowed: false,
      automaticMergeAllowed: false,
      uniqueContentMayBeDiscardedAutomatically: false,
    },
    summary,
    entries,
  };
}

function parseArgs(argv) {
  const args = { source: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source') args.source = argv[++index];
    else if (argv[index] === '--out') args.out = argv[++index];
    else if (argv[index] === '--help' || argv[index] === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return args;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.source) {
      console.log('Usage: node scripts/agent-catalog-inventory.mjs --source <legacy-corpus-dir> [--out <ledger.json>]');
      process.exitCode = args.help ? 0 : 2;
    } else {
      const ledger = buildInventory(args.source, args.out);
      const json = `${JSON.stringify(ledger, null, 2)}\n`;
      if (args.out) writeFileSync(resolve(args.out), json, 'utf8');
      else process.stdout.write(json);
    }
  } catch (error) {
    console.error(`Agent catalog inventory failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
