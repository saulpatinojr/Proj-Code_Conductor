# Code Conductor Constitution

This file defines repository-wide operating law for human and AI contributors.

## 1. Source-of-truth hierarchy

1. User-approved requirements and repository policy.
2. Executable repository evidence: tests, plans, diffs, CI, build results.
3. Official vendor documentation and official MCP-provided references.
4. Code Conductor run manifests and structured findings.
5. Agent recommendations and confidence statements.

A higher-capability model does not automatically overrule stronger evidence.

## 2. Separation of duties

- An implementing agent MUST NOT approve its own code.
- An implementing agent MUST NOT merge its own code.
- A reviewer is read-only unless explicitly reassigned as an implementer in a new task step.
- Security reviewers may block work but do not silently rewrite product code.
- High-impact or destructive production operations require explicit human approval.

## 3. Agent identity

An agent is defined by independent dimensions:

- provider
- model/capability tier
- execution harness/client
- billing channel
- role
- stance
- specialization
- skills
- tools
- authority
- risk clearance

Do not hard-code one vendor to one role when another qualified lane is available, except when a platform has unique first-party capabilities. Examples: GitHub Copilot/GitHub is preferred for GitHub-native PR review and repository checks; Kiro is preferred for specification-first planning; Perplexity is preferred for broad research discovery.

## 4. Stances

Assignments MUST declare a stance when the distinction matters:

- `constructive`: build, improve, solve, optimize.
- `critical`: challenge, find defects, identify risks, attempt to falsify assumptions.
- `neutral`: research, measure, validate, compare, arbitrate.

Critical agents must provide evidence for objections and must not manufacture disagreement merely to be contrarian.

## 5. Risk classes

- R0 trivial: single builder + deterministic check.
- R1 normal: builder + reviewer + tests.
- R2 important: builder + different-provider challenger + validator + GitHub review when applicable.
- R3 high: research/reference + architect/spec lead + builder + challenger + security + validator + GitHub review + finalizer + human approval.
- R4 destructive/production: R3 plus explicit human approval before external side effects.

## 6. Work isolation

- Modifying agents MUST use isolated Git branches/worktrees when work may overlap.
- Review-only agents should not receive a modifying worktree.
- A clean Git merge is not proof of behavioral correctness.
- Validation MUST be rerun after integration.

## 7. Evidence and validation

Every material finding should identify supporting evidence. Blocking findings MUST include evidence or a reproducible validation result.

Applicable deterministic checks may include formatting, linting, unit tests, integration tests, security scanning, Terraform validation/plan, Ansible lint, build checks, and GitHub Actions.

No agent may bypass a failing required gate merely by asserting confidence.

## 8. Official references

For technical claims that influence implementation, prefer and validate against official sources such as:

- GitHub documentation and official GitHub repositories
- Microsoft Learn / Azure documentation
- HashiCorp Terraform documentation and Registry
- Ansible documentation
- AWS documentation
- Google Cloud documentation
- Official OpenAI, Anthropic, Google, Kiro and Perplexity documentation

Perplexity may discover sources, but authoritative implementation decisions should be reconfirmed against official documentation where available.

## 9. Authentication and billing

- Prefer existing subscription-backed official clients before separately billed model APIs.
- Do not copy consumer OAuth/session credentials into Code Conductor.
- Do not commit tokens, API keys, cookies, refresh tokens, credentials, state files, or secrets.
- Code Conductor may detect authentication/billing state but does not become the credential authority.
- Separately billed API execution must be explicit and policy-controlled.

## 10. Packaging

- Microsoft APM is the package/dependency/integrity layer for reusable agent packs, skills, instructions, hooks and supported MCP declarations.
- `apm.yml` declares project package dependencies.
- `apm.lock.yaml` pins resolved dependency state.
- `apm-policy.yml` governs allowed package/MCP policy.
- Canonical agent-pack source lives in the Agent Packs repository (`saulpatinojr/Proj-Agent_Packs`), installed through APM at a pinned reference; Code Conductor ships no agent files, and `.apm/` here holds only Code Conductor's own skills (ADR 0015).
- Roles (`config/roles.yaml`) are runtime vocabulary: their authority and one-line rules are rendered into every assignment prompt by the runtime, not read from agent files.
- Do not manually fork equivalent agent instructions across Copilot, Claude, Codex, Kiro and Google when APM can project them.

## 11. Runtime orchestration

APM is not the runtime scheduler. Code Conductor owns:

- task decomposition and DAG
- capability-aware routing
- risk classification
- role/stance assignment
- authority enforcement
- bounded retry and escalation
- evidence collection
- disagreement arbitration
- integration readiness

MCP is the tool/reference plane, not the orchestration plane.

## 12. Context preparation

- Context reduction MUST preserve authoritative meaning by default. Comments, instructions, acceptance criteria, policy, and security rationale are not disposable whitespace.
- The context optimizer defaults to conservative/lossless preparation; aggressive comment or whitespace removal requires an explicit opt-in for content known to tolerate it.
- File-based context preparation MUST remain inside approved workspace roots after symlink/canonical-path resolution and MUST reject sensitive credential/state paths and unbounded reads.
- Token counts produced by local heuristics are estimates for relative telemetry, not vendor billing or quota data.
- Core context preparation remains provider-neutral. Provider-specific prompt/cache syntax belongs only in a validated provider adapter.
- The context optimizer's MCP transport is optional interoperability, not orchestration, and remains experimental until official SDK/protocol validation is complete.

## 13. Completion rule

The orchestrator owns the final result. Delegation does not transfer accountability.

Route by capability and unique platform advantage, escalate intelligently, challenge important work independently, merge deliberately, and verify after integration.
