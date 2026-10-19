---
description: Diagnose a GitHub Actions workflow that did not run, stayed queued, was
  skipped or failed
---

# Diagnose a GitHub Actions failure

## Inputs

Owner/repo, the workflow file or name, and the run URL, run ID, PR number or commit SHA that shows the problem. Optional: the last known good run, the expected trigger event, and any recent repository, runner or policy change. A diagnosis request authorizes reading, not rerunning, cancelling, dispatching or changing settings.

## Workflow

1. Orient with github-expert-orchestration and confirm the exact commit and event that should have produced a run.
2. Apply github-actions-debugging-and-troubleshooting: classify the failure before touching code (not discovered, event or path filter mismatch, skipped job, queued runner, permission denial, missing secret or variable, expression error, action failure, artifact or cache issue, environment approval, external dependency). Read the workflow file at the exact commit with `git show <sha>:<path>`, not at the current branch tip.
3. Apply github-api-cli-and-mcp-operations for remote reads: `gh run list`, `gh run view --log-failed` and `gh api` GET calls with an explicit repository, small limits and redaction. Note whether the run came from a fork, a bot or a Copilot branch, because each changes token permissions and approval requirements.
4. Compare with the last successful run, then state the smallest reproducible hypothesis and a safe local test.
5. When the fix is a workflow change, apply github-actions-workflows-and-security so the remediation does not widen permissions or add an unpinned action. Prepare the change locally; do not push.

## Expected output

A completion report naming the failure class, the commands run with redacted log lines, the confirmed cause or ranked hypotheses, the local remediation, and the evidence still unavailable. If a skipped or path-filtered workflow leaves a required check waiting, say so. Do not rerun, cancel, dispatch or enable debug logging without authorization. Follow the `github-expert-engineer-contract` instruction.