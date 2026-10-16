# ADR 0013 — Pre-action approvals bound to exact action context

- **Status:** Accepted
- **Date:** 2026-10-16
- **Decided by:** repository owner (approved scope C02 in #32/#44; directed implementation)
- **Related:** AGENTS.md §2 and §5, D-059, ADR 0005, issues #36 and #44

## Context

`cc run --execute` previously launched provider clients, ran the target repository's gate
commands and committed agent changes once workstation trust passed. Trust shows that an
installed client behaves as expected. It does not show that a person agreed to send *this*
prompt and repository to *this* provider, run *these* commands, or commit *this* diff.
C02 requires approval before local execution, confidential-context disclosure, commits and
deployments. That approval must be bound to scope, recipient, exact revision, context and
diff, and expire. Missing, denied and stale approvals must be rejected.

## Options considered

1. **Pre-recorded approvals in a local store, matched by digest** (`cc approve <digest>`,
   then re-run). Rejected. Task and run identifiers are random, worktree branches cannot be
   recreated for a re-run, and commit diffs only exist after a paid agent run. Re-running
   to apply an approval would repeat side-effecting work. A durable approval store also
   becomes standing authority that later actions could replay.
2. **One approval per run up front.** Rejected. It cannot see the diff or the gate
   working tree that exist only later. That would make it the blanket approval C02 forbids.
3. **Approval at the moment of each action, then re-verification** (chosen). Build the
   bound request, ask, rebuild and compare digests, then act.

## Decision

1. `ApprovalGate.authorize(build)` in `@code-conductor/policy` builds requests, asks an
   injected `Approver`, and approves only when four conditions hold:
   - a decision exists;
   - the decision is affirmative;
   - the decision arrived within the TTL (default 15 minutes);
   - rebuilt requests have identical SHA-256 digests over every bound field (the summary
     is excluded).

   Otherwise the status is `missing`, `denied`, `expired` or `changed`. Decisions are
   single-use and are never read back as authority.
2. Bound context:
   - recipient `provider/harness@surface`;
   - run, task and assignment;
   - working directory and HEAD;
   - the Git tree of tracked plus untracked non-ignored content, computed through a
     temporary index copy;
   - prompt digest and size, exact gate command plan, authority, surface and billing
     channel;
   - for commits, the exact tree, agent branch, base SHA and file list.
3. The runtime gates:
   - provider start and disclosure, together but recorded separately;
   - deterministic gate commands;
   - Code Conductor commits.

   Commits verify that the staged tree equals the approved tree. `deployment` is part of
   the contract for future native-pipeline connectors.
4. `cc run --execute` uses a terminal approver that requires the literal word `approve`.
   A non-interactive process cannot approve. There is no auto-approve flag.
5. `RunManifest.approvals` carries non-secret `ApprovalRecord` evidence. Any non-approved
   record makes the merge decision `human_required`.

## Consequences

- Execution is no longer unattended for any risk class. This matches C02. Programmatic
  callers must inject an `Approver` deliberately.
- A run needs about one prompt per provider assignment, one per gate run and one per
  commit. This cost is accepted for exact binding, which a coarser prompt cannot provide.
- Computing the working-tree identity may add unreferenced Git blob objects to the
  repository's object store. Git garbage-collects them normally. The index and working
  files are untouched. Ignored files are outside the binding.
- Denied provider starts remove the fresh empty worktree. Denied commits preserve changes
  uncommitted, consistent with ADR 0005's rule that agent work is never silently discarded.
- Backward compatible: `approvals` is optional in `RunManifest`.

## Validation

- `tests/policy/approvals.test.ts` covers:
  - digest binding and key-order independence;
  - the missing, declined, denied, expired, changed and approved paths;
  - single use;
  - per-provider distinct disclosure;
  - deployment requests;
  - malformed requests.
- `tests/runtime/approvals.test.ts` covers:
  - trust without an approver executes nothing;
  - fully approved runs reach `ready` with schema-valid evidence that excludes the prompt;
  - per-provider denial;
  - denied commits preserved uncommitted;
  - a diff that changes during review is rejected;
  - gate commands do not run without approval;
  - expiry.
- `tests/cli/approval-prompt.test.ts` covers non-TTY refusal, the exact confirmation word
  and control-sequence neutralization.
- Owner-workstation validation of the VS Code task-terminal prompt remains under #4.
