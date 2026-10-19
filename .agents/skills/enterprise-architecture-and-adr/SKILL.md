---
name: enterprise-architecture-and-adr
description: Make consequential TypeScript system decisions explicit through boundaries, trade-offs, ADRs, migration plans, and operational ownership.
---

# Architecture and ADRs

Connect the decision to business and operational outcomes. Map system boundaries, dependencies, data ownership, failure modes, deployment topology, support ownership, security, availability, recoverability, performance, cost, and team cognitive load.

Compare viable options using repository and product evidence. Prefer reversible evolutionary changes and avoid distributed or multi-agent complexity without a demonstrated need. Create or update an ADR for difficult-to-reverse choices using `adr-template.md`; never use an ADR to hide an unresolved approval.

Include migration sequencing, compatibility period, rollback or recovery, observability, and decision review triggers. Separate accepted decisions, proposals, assumptions, and open questions.
