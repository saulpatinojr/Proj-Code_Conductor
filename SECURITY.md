# Security Policy

## Supported versions

Code Conductor is pre-1.0. Security fixes are applied to the current `main` branch. No older release line is currently supported.

## Reporting a vulnerability

Do not open a public issue containing an exploitable vulnerability, secret, credential, token, or sensitive environment detail.

Prefer GitHub's private vulnerability reporting / Security Advisory flow for this repository when available. If that surface is unavailable, contact the repository owner privately through an established GitHub contact channel before disclosing details publicly.

A useful report includes:

- affected component and version/commit;
- reproduction steps or proof of concept;
- expected versus observed behavior;
- impact and required privileges;
- whether credentials or external systems are involved;
- suggested mitigation if known.

## Security boundaries

Code Conductor follows these baseline rules:

- consumer OAuth/session credentials stay in official vendor clients and credential stores;
- separately billed API execution is disabled by default;
- secret values must never be printed by `ccon doctor`, logs, run manifests, or evidence records;
- implementers cannot self-approve or self-merge;
- modifying agents use isolated Git worktrees, but worktrees are not treated as a security sandbox;
- unattended external CLI execution requires workstation smoke validation for the required authority;
- high-impact/destructive external actions require explicit human approval;
- MCP access is least-privilege and profile-driven;
- CI must not consume personal paid AI subscriptions.

See `AGENTS.md`, `docs/AUTHENTICATION.md`, and `docs/WORKSTATION-VALIDATION.md` for the authoritative operating rules.

## Dependency findings

Dependency warnings are tracked and triaged according to exploitability, runtime reachability, and whether they affect production or development-only tooling. High/critical findings that affect shipped or privileged runtime behavior are release blockers unless explicitly mitigated and documented.
