---
description: "Evaluate an agent workflow written in Python or TypeScript: scenarios, deterministic and judged checks, budgets, cost and a release recommendation"
---

# Evaluate an agent workflow

## Inputs

- The agent or workflow under evaluation and the repository it lives in.
- Task distribution, dataset and fixture provenance, expected and prohibited behavior, tool and safety policy, and approved thresholds with their owner.
- Run budgets, and whether any paid or provider evaluation is authorized.

## Workflow

1. Identify the system's language from its files, and use that language's references in each skill.
2. Apply agent-evaluation to define the scenarios, rubric, scoring and run plan, and secure-agent-engineering for injection, exfiltration and tool-misuse cases. Delegate to the agent-evaluation-engineer specialist when independent evaluation evidence helps.
3. Run deterministic checks against mocks first, then recorded fixtures, then live providers only within the authorized budget.

## Expected output

The scenario set and rubric, commands and results, dataset, prompt, tool and model versions, deterministic and judged results kept separate, cost and latency, limitations, and a release recommendation for the owner to decide, followed by a completion report in the format of the installed pack's contract instruction.

## Guardrails

Do not run cost-bearing evaluations without authorization, send sensitive fixtures to an unapproved judge, or present a draft threshold as policy.
