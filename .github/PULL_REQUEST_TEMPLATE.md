## Summary

Describe the problem, the change, and why this approach was chosen.

## Risk

- Risk class: `R0` / `R1` / `R2` / `R3` / `R4`
- External/production side effects: none / describe
- Authentication, billing, MCP, or security-boundary changes: none / describe

## Validation

- [ ] `npm ci --ignore-scripts`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run ccon:validate`
- [ ] APM audit completed when `.apm/`, `apm.yml`, `apm.lock.yaml`, or `apm-policy.yml` changed
- [ ] Generated APM projections and lockfile are current when canonical pack source changed
- [ ] Relevant workstation/harness smoke validation completed for execution-boundary changes

## Governance

- [ ] I read `AGENTS.md` and applicable repository instructions.
- [ ] No locked decision was changed without an ADR and `docs/DECISIONS.md` update.
- [ ] Documentation was updated where behavior/setup/policy changed.
- [ ] No secrets, tokens, cookies, credentials, state files, or sensitive environment data are included.
- [ ] The implementer is not being used as the sole approver of its own work.
- [ ] Any R3/R4 or destructive/external action retains the required human approval boundary.

## Evidence / findings

Link tests, logs, issues, ADRs, official documentation, or Code Conductor run/evidence records that support the change.

## Follow-up

List deferred work explicitly. Do not hide known blockers inside a merge-ready PR.
