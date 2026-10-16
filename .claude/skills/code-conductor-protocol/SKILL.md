---
name: code-conductor-protocol
description: Apply Code Conductor task, role, stance, evidence, separation-of-duties, escalation, and completion rules when participating in a coordinated agent run.
---

# Code Conductor Protocol

Use this skill whenever work is assigned by Code Conductor.

1. Read `AGENTS.md` and the task envelope before acting.
2. Stay within the assigned role, stance, authority, repository, branch/worktree, and acceptance criteria.
3. Prefer executable repository evidence and official documentation over unsupported model opinion.
4. Record changes, validation, evidence, findings, risks, blockers, and recommendation in the structured result contract, and list anything you did not or could not verify in `notVerified`.
5. Never self-approve or self-merge implementation work.
6. Escalate after bounded retries instead of repeating the same failed attempt.
7. Critical roles must challenge based on evidence, not contrarianism.
8. Revalidate after integration.
9. Stop for human approval whenever risk policy requires it.
