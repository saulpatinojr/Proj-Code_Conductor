# Handoff packets and local evidence

Implements I05 from #32/#37. Decision: D-063. Contract: `HandoffPacket` in
`packages/schemas`.

## Handoff packets

When an assignment depends on completed work, such as a reviewer or challenger after the
builder, Code Conductor builds a versioned **handoff packet** for that one recipient. The
packet records:

- **Recipient and senders:** the assignment, agent, provider, harness and surface of each.
- **Expiry:** 24 hours by default (`handoffTtlMs`). An expired packet is never handed off.
- **Authorised context:**
  - the task objective, acceptance criteria and constraints;
  - what earlier assignments reported changing (the files actually committed);
  - what they did not verify (`notVerified`);
  - the risks they named.
- **Prior findings,** to be verified independently rather than assumed fixed.
- **Unresolved disagreements,** for example the builder recommending `ready` while a
  challenger has a blocking finding.
- **Provenance:** the repository, revision and tree the recipient works on, plus the
  evidence IDs behind the claims.

The packet is rendered into the recipient's prompt (at most 8 KB), labelled as claims to
verify, not evidence. Because the prompt includes it, the recipient's context-disclosure
approval binds the packet too ([`APPROVALS.md`](APPROVALS.md)).

Each packet is stored privately with its run as `handoffs/<id>.json` (owner-only
permissions). The manifest records its id, recipient, expiry and SHA-256
(`RunManifest.handoffs`). Reading a packet back verifies that digest, so an edited
packet is rejected.

`cc handoff --run <runId> --assignment <id>` prints the recipient's exact prompt, including
its packet, for a manual run in an official client (C03). `--json` prints the packet
itself. Both refuse an expired or altered packet.

## Local evidence and retention

All run evidence is local and owner-private: manifests, events, approval records and
handoff packets live under `~/.code-conductor/runs` (or `$CODE_CONDUCTOR_HOME/runs`). There
is no central session database or service.

- `cc runs` lists stored runs with their decision, age and any live worktrees.
- `cc runs --older-than <days>` previews which runs' evidence would be deleted, and
  `--apply` deletes it.
- Runs whose agent worktrees still exist are kept; review or remove those worktrees first
  ([`WORKTREES.md`](WORKTREES.md)). Retention never touches worktrees or branches.

Nothing is deleted automatically. How long to keep evidence is your decision.
