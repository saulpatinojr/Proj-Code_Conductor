# Governance & Policy Review Reference

When reviewing changes to `packages/policy/**`, `config/**`, `.apm/**`, or documentation:

## Separation of Duties
- The implementing agent (`builder`) must never be granted authority to self-review, self-approve, or self-merge.
- High-impact or destructive actions (R3/R4) must retain explicit human approval boundaries.
- For R2+ tasks, the challenger must use an independent provider different from the builder.

## APM & Agent Projections
- Canonical agent and skill definitions reside in `.apm/`.
- Generated projections in `.github/agents/`, `.claude/`, `.codex/`, `.kiro/`, and `.agents/skills/` must remain in lockstep with canonical `.apm/` sources.
- `apm.lock.yaml` must not be manually edited; update via APM CLI.

## Architecture Decision Records (ADRs)
- Changes affecting locked decisions in `docs/DECISIONS.md` require an ADR in `docs/adr/` within the same pull request.

## Verification Commands
```bash
npm run ccon:validate
apm audit --ci --policy ./apm-policy.yml --no-fail-fast
```
