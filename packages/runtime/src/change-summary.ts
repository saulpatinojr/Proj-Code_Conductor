// Shared wording for approval summaries of changed files and commits.

// Files that can change what later runs: CI, Git hooks, scripts, dependencies and
// package-manager settings, Git behaviour, and agent, editor or dev-container
// configuration that clients load automatically. Matched case-insensitively, because
// case-insensitive file systems load `.Claude/` as `.claude/`.
const EXECUTION_RELEVANT_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.envrc', 'makefile', 'dockerfile', 'jenkinsfile',
  '.gitattributes', '.gitmodules', '.gitignore', '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml',
  '.gitlab-ci.yml', 'azure-pipelines.yml', '.mcp.json', 'agents.md', 'claude.md', 'gemini.md', 'apm.yml', 'apm.lock.yaml', 'apm-policy.yml',
]);
const EXECUTION_RELEVANT_DIRECTORIES = new Set(['.github', '.husky', '.githooks', 'scripts', '.circleci', '.devcontainer', '.vscode', '.claude', '.codex', '.cursor', '.gemini', '.kiro']);
const EXECUTABLE = /\.(sh|bash|zsh|ps1|psm1|cmd|bat|exe)$/;
export function executionRelevant(file: string): boolean {
  const segments = file.toLowerCase().split('/');
  const leaf = segments.at(-1) ?? '';
  return EXECUTION_RELEVANT_FILES.has(leaf) || EXECUTABLE.test(leaf) || segments.slice(0, -1).some((segment) => EXECUTION_RELEVANT_DIRECTORIES.has(segment));
}
// Leads with the counts, so a truncated display still says how many files can change
// what later runs; those files are listed before any others.
export function summarizeFiles(files: readonly string[]): string {
  const relevant = files.filter(executionRelevant);
  const others = files.filter((file) => !executionRelevant(file));
  const shown = others.slice(0, 20);
  return `${files.length} changed file(s), ${relevant.length} of them able to change what later runs (CI, hooks, scripts, dependencies, agent or editor configuration)${relevant.length ? `: ${relevant.join(', ')}` : ''}. ${others.length ? `Other files: ${shown.join(', ')}${others.length > shown.length ? `, … (${others.length - shown.length} more)` : ''}` : 'No other files'}`;
}
export function shortList(shas: readonly string[], limit = 10): string {
  return `${shas.slice(0, limit).map((sha) => sha.slice(0, 12)).join(', ')}${shas.length > limit ? `, … (${shas.length - limit} more)` : ''}`;
}
