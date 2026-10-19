---
description: Review GitHub Copilot instructions, custom agents, skills, MCP configuration
  and code review settings for a repository
---

# Review a repository's GitHub Copilot setup

## Inputs

Owner/repo and branch, the Copilot features in scope (code review, cloud agent, IDE or CLI, custom agents, agent skills, MCP servers), and the governance question, for example whether automatic review is safe to enable or whether an instruction file exposes sensitive data. Optional: the Copilot plan and organization policy, if known.

## Workflow

1. Orient with github-expert-orchestration and record plan, organization policy and repository eligibility as confirmed or not verified.
2. Apply github-copilot-engineering: keep code review, cloud agent, IDE, CLI, custom agents, skills and MCP separate. Inspect the repository-wide and path-specific Copilot instruction files under `.github/`, the `.github/agents` and `.agents/skills` folders, and MCP configuration on the exact branch Copilot will read (for code review, the PR head branch). Check scope, prompt injection, sensitive data, permissions, cost ownership, and the human gates that must stay in place.
3. Apply github-documentation-and-repository-contracts: find contradictions between Copilot instructions and CONTRIBUTING, CODEOWNERS, SECURITY or workflow rules, and name the authoritative source for each rule.
4. For MCP servers, apply github-api-cli-and-mcp-operations: trusted servers only, least-privilege toolsets, explicit repository scope, and read-only mode where possible.

## Expected output

A completion report listing each Copilot surface with its configuration evidence, findings, and the settings that could not be read, plus proposed local edits to instruction or agent files when the user asks for them. Do not enable or change Copilot policy, billing, automatic review, MCP servers or agent permissions without authorization. Follow the `github-expert-engineer-contract` instruction.