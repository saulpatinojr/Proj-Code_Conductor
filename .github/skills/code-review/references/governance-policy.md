# Governance & Policy Review Reference

When reviewing changes to `packages/policy/**`, `config/**`, `.apm/**`, or documentation:

## Separation of Duties
- The implementing agent (`builder`) must never be granted authority to self-review, self-approve, or self-merge.
- High-impact or destructive actions (R3/R4) must retain explicit human approval boundaries.
- For R2+ tasks, the challenger must use an independent provider different from the builder.

## APM & Agent Projections
- `.apm/` holds only Code Conductor's own skills. Specialist agents come from the Agent Packs repository through APM; an agent file added to `.apm/agents/` or any projection directory is a test fixture at most and should be questioned (ADR 0015).
- Role rules live in `config/roles.yaml` (`instructions`) and are rendered by the runtime; a rule must be one line, at most 300 characters, with no control characters.
- Generated projections in `.claude/`, `.codex/`, `.kiro/`, `.github/` and `.agents/skills/` must remain in lockstep with `.apm/` sources.
- `apm.lock.yaml` must not be manually edited; update via APM CLI.

## Architecture Decision Records (ADRs)
- Changes affecting locked decisions in `docs/DECISIONS.md` require an ADR in `docs/adr/` within the same pull request.

## Verification Commands
```bash
npm run ccon:validate
apm audit --ci --policy ./apm-policy.yml --no-fail-fast
```
