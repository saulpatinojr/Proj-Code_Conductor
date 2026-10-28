# ADR 0019 — Pack controls, short interview and a live orchestrator blueprint

- **Status:** Proposed
- **Date:** 2026-10-28
- **Scope:** owner-clarified #140/#142 UX and orchestrator context/handoff files
- **Related:** ADR 0013, ADR 0015, ADR 0016, ADR 0018; D-059, D-060, D-076, D-078

## Context

The owner clarified the intended interaction: **+** downloads available pack
names/versions, **−** permits pending **×** removals, and **Save** commits that
removal batch and triggers orchestrator reevaluation. Additions illuminate a
separate **Orchestrator** button. The rebuilt files must make the existing runtime
use appropriate agents and handoffs together. The owner selected metadata
validation plus approved AI review, with quickness and quality both required.

The supplied `agent-definition-blueprint.md` separates identity, behavior,
capabilities, project context, memory and curated references. The owner wants a
short first-install interview, useful defaults and Redo. The document is a design
reference; its Azure/iOS/personal-assistant examples are not facts or defaults for
an unrelated repository. Do not publish the uploaded document wholesale or treat
its illustrative instructions as higher-priority execution policy.

## Decision

### Pack interaction and transactional intent

1. **+** performs bounded on-demand catalog/version discovery from the canonical
   Agent Packs distribution mirror. Fetch metadata only; hide installed exact
   versions and identify updates. Select an immutable full commit, verify package
   name/version/source compatibility and pass the selection through ADR 0018's
   exact native artifact preview/approval/application/audit flow. Do not install
   the whole catalog or start an AI/provider merely to populate the picker.
2. **−** enters scoped removal editing. **×** toggles pending removal with undo;
   Cancel discards the draft. Pending selections bind the original repository
   and installed pack/version digest. External pack changes invalidate the draft
   before Save rather than removing a different/newer version accidentally.
3. **Save** submits the whole removal batch and orchestrator reevaluation as one
   workflow. It is the commit trigger; marking **×** does not mutate anything.
   Stage the resulting pack set and proposed blueprint/handoff changes, show the
   combined diff and obtain fresh action approvals before application. Do not
   leave a success state with dangling references to removed agents. Failed or
   partial application/audit remains an explicit pending/repair state.
4. Successful additions mark the blueprint out of date and illuminate an
   accessible native **Orchestrator** control. It stays pending until the user
   invokes regeneration and its proposed files pass review, validation and
   application. Removals initiate reevaluation through Save, without another
   required Orchestrator click. Empty/no-change actions are explicit and idempotent.

### A short first-use interview

Offer setup on the first explicit orchestrator use/first-run welcome action;
do not block ordinary Code Conductor use or perform model/network/file writes
at extension activation. One compact setup has at most three prompts:

| Prompt | Initial value |
|---|---|
| Mission and success | Repository-declared purpose when safely available; editable project goal. |
| Priorities and constraints | Repository policy and installed-pack/domain suggestions, with their sources. |
| Working style | Pragmatic, curious, concise; preserve quality checks and show uncertainty. |

Provide **Use defaults** and **Customize**, then a single preview. Derive roles,
domains, skills, tool states and source links from verified workspace/pack data
instead of asking ten separate questionnaires. Required unknowns remain visible;
AI must not fabricate a project phase, account, prior decision or credential.
Distinguish user-confirmed, repository-declared, default and AI-proposed values.
An unavailable tool is unavailable/unknown, not a permission implied by an answer.

**Redo Interview** is always available, prefills the last confirmed repository-
scoped answers and permits changing selected fields. Cancel preserves the last
confirmed state. Redo produces a new reviewed diff; it never wipes memory,
annotations or existing instructions. First-run defaults do not silently become
claims about the user's history.

### Files and ownership

Use the blueprint's `.agent/` structure for first-party team context, alongside
a versioned orchestration/handoff contract. These are distinct from reusable
specialist definitions, whose single source remains Agent Packs (D-076).

| File | Content owner / derivation |
|---|---|
| `.agent/SOUL.md` | Confirmed purpose, values and collaboration style. |
| `.agent/IDENTITY.md` | Team/orchestrator role and actual installed domains. |
| `.agent/INSTRUCTIONS.md` | Rendered first-party collaboration/handoff protocol, subordinate to governing policy. |
| `.agent/GUARDRAILS.md` | Current policy summary/source links; cannot grant or weaken permissions. |
| `.agent/SKILLS.md` | Index of actual APM skills and source versions; no copied specialist instruction forks. |
| `.agent/TOOLS.md` | Actual tools, available surfaces and distinct discovered/authenticated/trusted states. |
| `.agent/CONTEXT.md` | Current project/phase/task facts with provenance; unknowns labeled. |
| `.agent/MEMORY.md` | Durable confirmed preferences/decisions/lessons and citations; preserve human prose. |
| `.agent/KNOWLEDGE.md` | Curated source links/ADRs; optional verified knowledge references. |
| `.agent/GOALS.md` | Confirmed goals, constraints and success criteria. |
| `.agent/ORCHESTRATOR.md` | Human-readable team routing/dependency/handoff blueprint and source pins. |
| `.agent/orchestration.json` | Strict versioned machine-readable blueprint consumed by the runtime. |
| `.agent/handoffs/*.md` | Typed handoff templates used by existing per-run handoff generation. |

All ten core files can be lightweight; completeness of the structure does not
require ten long documents. Generate indexes/links rather than duplicate skill
bodies or private transcripts. Existing AGENTS.md and native client instructions
retain their authority and ownership. A bootstrap link may be proposed separately;
never replace an existing constitution or silently rewrite human instructions.

Keep ownership receipts and last-confirmed interview answers owner-private and
repository-bound. Generated-region ownership requires a recorded accepted baseline,
not just a marker in an arbitrary file. Preserve bytes outside managed regions.
Edits inside managed regions, duplicate markers, unsupported legacy files or
conflicts require an explicit merge/export proposal, not overwrite. Apply the
whole approved before/after file digest through ADR 0018's guarded artifact path;
file types/modes/absence and fresh context still bind the decision.

No credentials, native auth state, private run transcripts or automatic vault sync
enter these files. Memory is curated context, not perfect recall or execution
authority. Per-run private evidence/HandoffPackets stay in their existing store.

### Fast generation with quality gates

Build a deterministic candidate from all installed pack metadata, actual agent/
skill definitions and current runtime role/capability/authority policy. Batch pack
changes and compute the affected role/dependency/handoff delta. Use an approved
read-only AI review inside the existing runtime boundary; the UI must not call
providers directly. Reuse/extract the common client/auth/trust/surface, native
adapter, context-disclosure, action-approval and evidence checks. Honor stronger
risk-specific review requirements where applicable.

Use official subscription-backed clients where permitted; no paid API fallback,
MCP activation or always-on provider. Missing readiness or denied/expired/changed
approval leaves a proposal/pending state. Model output is schema-validated advice;
it cannot choose arbitrary file paths, grant authority, execute commands or declare
the deployment verified. Render files through first-party typed templates only.

Review only changed decision inputs while deterministically validating the whole
resulting graph. Cache a validated analysis only by complete relevant input hashes:
selected source commits, actual agent/skill content, role/capability/policy versions,
interview/goal/context inputs and prior blueprint. A cached analysis is not a
reusable approval. Describe cache reuse honestly; do not claim a new AI review ran.

Blocking validation includes unknown/unavailable agents or surfaces, unsupported
capabilities, missing handoff recipients, duplicate identities, cycles, dangling
pack/source references, role separation violations and authority exceeding current
policy. Preserve unknown/unverified facts. Native package portability warnings
remain visible. Pass native APM audit for package artifacts and separate first-
party schema/graph/ownership tests for the blueprint.

### Runtime use and authority

The existing planner/executor remains the scheduler and execution owner. It must
actually read the validated blueprint when selecting eligible specialists and
rendering handoff context/templates; disconnected generated documentation does
not satisfy the requirement. The blueprint only selects within currently allowed
and available roles, native surfaces and authority. It cannot remove risk-required
reviewers/validators or bypass current harness trust/approval checks.

Verify the blueprint's pack/source digest against current installation and validate
its schema before use. A stale/invalid blueprint cannot route to removed or
unsupported agents. Show the pending state and use only an honest permitted
generic/manual fallback, or block when a required specialist is unavailable.
Read relevant SOUL/context/memory data losslessly under existing safe-read and
source-disclosure rules. Native invocation must be verified for the actual client;
unsupported binding remains manual/unavailable rather than pretending an agent ran.

## Consequences

This introduces a first-party optional project-context write/read boundary and a
guarded orchestrator-review action, requiring a narrow D-060 amendment before
implementation is exposed. It does not activate the deferred workflow designer,
hosted state, centralized database, broad cloud sync or custom credential broker.
The existing Obsidian adapter remains optional/read-only until its own write
boundary is reviewed. Redo and pack Save never infer permission to edit a vault.

Unsupported hosts or missing native readiness remain explicit. First-install UX
must fit native keyboard/accessibility conventions and warm-start budgets. Most
setup fields are derived; quality does not depend on asking the owner a long list
of questions or rerunning a full AI analysis for unchanged inputs.

## Validation

Before acceptance, independently review authority, file ownership, actual runtime
consumption, native-agent binding, interview provenance, cache invalidation and
provider/context privacy. Test catalog/version filtering and pinning; +/−/×/Save
state across two roots/restarts/external changes; combined removal/rebuild failures;
illuminated/pending/ready states; three-prompt/default/Redo/cancel paths; preservation
of human memory/annotations; all blueprint files and source references; schema/DAG/
capability/role gates; cache hits/misses; denied/missing/expired/changed approvals;
and zero startup model/network/write activity. Use native VSIX interaction evidence
and fake provider fixtures for deterministic CI; never use personal subscriptions
in CI or claim a live model ran from a cached/mocked result.
