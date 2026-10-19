---
name: github-actions-debugging-and-troubleshooting
description: Diagnose GitHub Actions workflow discovery, trigger, queue, permission, runner, expression, dependency, artifact, cache, and log failures.
---

# Actions Debugging

Classify the failure before changing code: workflow not discovered, event filter mismatch, skipped job, queued runner, permission denial, missing secret/variable, expression/context error, action failure, artifact/cache issue, environment approval, or external dependency.

Collect workflow file at the exact commit, event payload, run and job IDs, actor, ref, workflow permissions, environment, runner, relevant log lines, annotations, prior successful run, and repository policy. Redact tokens and secret values. Verify whether the run was triggered by a fork, bot, or Copilot branch.

Use `gh run view` and `gh run download` read-only where authorized; do not rerun or cancel as a diagnostic shortcut. Record the smallest reproducible hypothesis, safe local test, remediation, and evidence still unavailable. Beware skipped jobs and stale required checks that make a green-looking run misleading.
