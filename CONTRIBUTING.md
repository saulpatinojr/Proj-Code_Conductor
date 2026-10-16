# Contributing to Code Conductor

Code Conductor is developed through small, reviewable Git changes with deterministic validation and explicit separation of duties between implementation and approval.

## Before changing code

1. Read `AGENTS.md` for repository-wide operating rules.
2. Read `docs/DECISIONS.md` for locked decisions.
3. Read `docs/STATUS.md` for the current implementation checkpoint.
4. Read the relevant architecture, authentication, MCP, UI, or workstation document under `docs/`.
5. If a change would supersede a locked decision, create an ADR in `docs/adr/` in the same PR.

## Branches

Use short-lived branches from `main`:

- `feature/<scope>` for new behavior
- `fix/<scope>` for defects
- `docs/<scope>` for documentation-only work
- `chore/<scope>` for maintenance
- `bootstrap/<scope>` only for temporary repository bootstrap work

Delete merged short-lived branches. Do not use long-lived personal integration branches.

## Commits

Prefer Conventional Commit-style messages such as:

- `feat: add harness capability probe`
- `fix: preserve worktree on blocked gate`
- `docs: update workstation validation`
- `chore: refresh generated APM projections`

Keep commits focused enough to review and revert independently.

## Local validation

For TypeScript changes:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run ccon:validate
```

For APM source, manifest, or policy changes:

```bash
apm targets
apm install
apm audit --ci --policy ./apm-policy.yml --no-fail-fast
```

Commit intentional updates to `apm.lock.yaml` and generated harness projections. Never hand-edit `apm.lock.yaml`.

For subscription-backed harness execution, follow `docs/WORKSTATION-VALIDATION.md`. CI must not consume personal paid AI subscriptions.

## Pull requests

Every PR must:

- describe the problem and scope;
- state the risk class when runtime behavior changes;
- identify validation performed;
- update documentation when behavior, policy, or setup changes;
- keep generated APM projections consistent with canonical `.apm/` source;
- avoid secrets, tokens, state files, or credential material;
- satisfy required GitHub Actions checks before merge.

An implementing agent or contributor must not self-approve in place of required independent review. Human approval remains the final authority for consequential changes.

## Architecture decisions

Use `docs/adr/` when a change alters a locked decision, a major system boundary, an authentication/billing boundary, a security boundary, or a provider/harness contract. Update `docs/DECISIONS.md` in the same PR when an ADR changes a locked baseline.

## Documentation convention

- `README.md`: project entry point and quick start.
- `AGENTS.md`: repository constitution.
- `STARTER.md`: concise handoff for a new AI/human work session.
- `docs/STATUS.md`: current checkpoint and immediate next milestone.
- `docs/README.md`: documentation index.
- `docs/DECISIONS.md`: durable decision register.
- `docs/adr/`: architecture decision records.
- `CHANGELOG.md`: user/developer-visible changes by release.

Do not duplicate the same operational truth across many files when a link to the authoritative document is sufficient.
