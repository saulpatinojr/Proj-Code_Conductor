---
name: secure-agent-engineering
description: "Assess and harden agentic applications written in Python or TypeScript: prompt injection, tool misuse, memory poisoning, tenant isolation, unsafe code execution, supply chain, privacy and responsible AI, plus each language's own dangerous APIs. Use when agent, retrieval, browser, model output, MCP, dependency or durable-memory boundaries are in scope."
---

# Secure Agent Engineering

## Purpose and activation

Find and close the ways an agent, its tools or its data can be turned against the user, the organization or other tenants. Activate when agent, retrieval, browser, model output, MCP, dependency or durable-memory boundaries are in scope, in Python, TypeScript, or both.

## Scope and exclusions

In scope: authentication and authorization, least privilege, secrets, input and output validation, injection (prompt, command, SQL, path), SSRF, XSS and CSRF, unsafe deserialization and code execution, dependency and supply-chain risk, telemetry leakage, privacy, and for agents: prompt injection, tool misuse, privilege escalation, confused-deputy use, context and memory poisoning, unsafe handoffs, excessive autonomy, denial of wallet and approval bypass. Responsible-AI review covers purpose and disclosure, data minimization, grounding, contestability, human oversight and fairness. Out of scope: sending confidential prompts, source or customer data to an unapproved service, and exploiting live systems.

## Inputs

Prompt, tool, retrieval and memory flows, identities and tenancy, approvals and oversight, the data classification and policy, misuse scenarios, the dependency manifests and lockfiles, and the language of each component.

## Dependencies and tools

- The application's policy enforcement layer and sanitized security and evaluation fixtures.
- The repository's existing scanners and linters, run read-only.
- [references/python.md](references/python.md) and [references/typescript.md](references/typescript.md): each language's dangerous APIs, safer replacements and supply-chain controls.

## Workflow

1. Identify the language from the code, not from which pack is installed. Python shows up as `pyproject.toml`, `requirements*.txt`, `setup.cfg`, `uv.lock`, `poetry.lock` or `.py` sources. TypeScript or JavaScript shows up as `package.json`, `tsconfig.json`, a lockfile such as `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `bun.lock`, or `.ts`, `.tsx` and `.js` sources. In a repository with both, review each component against its own language's risks, and review the boundary between them on both sides. Then read the reference for that language. A risk that exists in one language may not exist in the other, so never copy a finding across without checking it in the other language.
2. Map instruction and data boundaries. Treat retrieved documents, browser text, tool results, skills, memory and model-generated code as untrusted.
3. Enforce authorization, approvals and budgets in deterministic code outside the model, and narrow every tool to the domains, files, records and actions it needs. Prevent confused-deputy use and cross-tenant context.
4. Validate at runtime every value that crosses a trust boundary. Neither language enforces its types at runtime, so a type annotation is never a security control.
5. Find the language's dangerous APIs in the code paths that touch untrusted data: dynamic evaluation, deserialization that runs code, shell execution, path handling, and the language-specific classes in the table below.
6. Never run model-generated or user-supplied code in the application's own process. Neither language has a safe in-process sandbox; use a separate, isolated process or container with no secrets and no network unless required.
7. Review the supply chain in the ecosystem's own terms: lockfiles, install-time code execution, pinning and the ecosystem's audit tool.
8. Review purpose and disclosure, data minimization, expiry and deletion, grounding and provenance, contestability, accessible escalation, human oversight, fairness and monitored feedback. Use protected-characteristic data only for a documented, lawful and approved purpose, and require human judgment for consequential decisions.
9. Turn findings into executable negative cases: exfiltration, injection, malformed results, poisoned memory, denial of service, approval bypass and excessive autonomy. Hand them to agent-evaluation.

### Where Python and TypeScript differ for security

| Concern | Python | TypeScript |
|---|---|---|
| Types at runtime | hints are not enforced; validate with a schema library | types are erased; validate with a schema library |
| Code execution from data | `eval`, `exec`, and loading `pickle`, `shelve` or unsafe YAML | `eval`, `new Function`, and the `vm` module, which Node.js says is not a security mechanism |
| Shell commands | `subprocess` with `shell=True` and untrusted input | `child_process.exec` with a command string |
| Object model attacks | not applicable in the same form | prototype pollution through `__proto__`, `constructor` or `prototype` keys in merged input |
| Denial of service | blocking calls inside async code stall the event loop | one event loop serves every request, so a slow regular expression (ReDoS) or CPU-heavy work blocks all of them |
| Install-time code execution | building a source distribution runs its build backend's code | npm runs lifecycle scripts such as `postinstall`; disable them with `--ignore-scripts` |
| Lockfiles and audit | hash-checking mode (`--require-hashes`), `uv.lock` or `poetry.lock`, pip-audit | `package-lock.json` with `npm ci`, `npm audit` |
| Secrets in the client | no browser bundle | anything bundled for the browser is public, including environment variables exposed to the client |

## Output

A threat model, findings with evidence, severity, impact, remediation and residual risk, each marked static or runtime-confirmed; an executable negative-case plan; responsible-AI constraints; and a release or escalation recommendation.

## Validation

Record the exact checks run, their results, and the evidence that was unavailable. A finding is runtime-confirmed only when a test or reproduction showed it. A draft, a static check or a local mock does not establish live behavior.

## Failure handling and escalation

- A policy enforced only by model prose: report it as a finding and design an enforcement point outside the model.
- Missing tenant isolation, retained secrets or an unsafe fallback: report the highest severity justified by the evidence and escalate.
- A suspected live compromise or leaked credential: stop, do not test further, and escalate to the owner at once.
- A missing input or approval: stop only the dependent operation and continue the useful authorized work.

## Permissions and guardrails

Review read-only unless the assignment covers fixes. Never put secrets in source, prompts, fixtures, logs, examples or test output. Never bypass a control, weaken a test or disable a scanner to make a check pass. Request approval for privileged or externally visible actions. Do not send confidential data to an unapproved evaluator. A specialist cannot approve its own work or expand its assignment.

## Connection to the pack

This skill ships unchanged in the Python and TypeScript Distinguished Engineer packs, so whichever pack is installed last leaves the same skill in place, and either pack can review a system in either language. The always-on agentic-security instruction points here. Installed on its own, the skill still works and the guardrails above still apply. Installed with a pack, it follows that pack's always-on contract instruction for approval levels, handoffs and the completion report.
