---
name: github-copilot-engineering
description: Configure, use, review, and govern GitHub Copilot code review, cloud agent output, custom agents, instructions, skills, MCP context, and AI-assisted delivery.
---

# GitHub Copilot Engineering

Separate Copilot code review, Copilot cloud agent, IDE features, CLI features, custom agents, agent skills, and MCP servers. Verify plan, organization policy, repository eligibility, licensing, AI-credit ownership, Actions minutes, and whether automatic review is enabled.

Review `.github/copilot-instructions.md`, path-specific instruction files, `.github/agents`, `.agents/skills`, and MCP configuration for scope, prompt injection, sensitive data exposure, permissions, and reproducibility. Copilot reads instructions and skills from the pull request head branch; validate the exact branch content.

Copilot output is untrusted generated work. Inspect the complete diff, tests, dependencies, workflow changes, secrets, generated code, and license concerns. Do not count an AI approval as a human approval. For automatic review, check triggering rules, draft/new-push behavior, effort level, excluded files, cost, and required human gates. Do not enable policy, billing, MCP, or agent permissions without authorization.
