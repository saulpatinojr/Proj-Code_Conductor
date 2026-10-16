# Handoff packets and local evidence

Implements I05 from #32/#37. Decision: D-063. Contract: `HandoffPacket` in
`packages/schemas`.

## Handoff packets

When an assignment depends on completed work, such as a reviewer or challenger after the
builder, Code Conductor builds a versioned **handoff packet** for that one recipient.
Only the assignments it depends on contribute. The packet records:

- **Recipient and senders:** the assignment, agent, provider, harness and surface of each.
- **Expiry:** 24 hours by default (`handoffTtlMs`). An expired packet is never handed off.
- **Authorised context:**
  - the task objective, acceptance criteria and constraints;
  - the files Code Conductor committed for earlier modifying assignments (a read-only
    assignment's own claim to have changed files is not carried);
  - what they did not verify (`notVerified`);
  - the risks they named.
- **Prior findings,** to be verified independently rather than assumed fixed.
- **Unresolved disagreements** among those dependencies, for example the builder
  recommending `ready` while a challenger has a blocking finding.
- **Provenance:** the repository, revision and tree the recipient works on, plus the
  evidence IDs behind the claims.

Everything earlier agents wrote is untrusted. So the packet is handled like this:

- **Credential-looking strings are redacted** when the packet is built, using the same
  patterns as the commit scan ([`WORKTREES.md`](WORKTREES.md#commits)). They are never
  passed on to another provider.
- **In the recipient's prompt it is a closed block,** between `BEGIN HANDOFF <id>` and
  `END HANDOFF <id>`. The packet id is random and created after those agents finished,
  so none of them can close the block early.
- **Every value they wrote is a JSON string on its own labelled line.** Control, format
  and line-separator characters are escaped, and Code Conductor's result marker is
  neutralised.
- **The block is labelled as claims to verify,** not evidence and not instructions. It
  is bounded to 8,000 characters of their data, plus at most 1,000 characters of evidence
  ids in the provenance line. It always ends with its provenance and `END` marker before
  Code Conductor's own instructions.

Because the prompt includes the packet, the recipient's context-disclosure approval binds
it too. The approval names it: its id, digest, senders, the counts of findings, risks,
unverified checks and committed files, and how many values were redacted
([`APPROVALS.md`](APPROVALS.md)).

Two rules prevent stale or unchecked disclosure:

- **No Git until the control check passes.** A packet is built only after the
  Git-control check for the recipient's working tree passed, because its provenance
  hashes that tree with `git add` ([`WORKTREES.md`](WORKTREES.md)).
- **No expired packet is disclosed.** The approval request is rebuilt after the person
  decides, so a packet that expired in the meantime is refused. The same rebuild checks
  Git configuration again before hashing the tree, as the gate and commit approvals do.

Lifetimes longer than 7 days, or not positive, are rejected before a run starts.

Each packet is stored privately with its run as `handoffs/<id>.json`, with owner-only
permissions and at most 4 MiB. The manifest records its id, recipient, expiry and SHA-256
(`RunManifest.handoffs`). Reading a packet back verifies that digest, so an edited packet
is rejected. Imported manifests cannot carry handoff references (`ccon import`), because
they would look like this store's own evidence.

`ccon handoff --run <runId> --assignment <id>` prints the recipient's exact prompt, including
its packet, for a manual run in an official client (C03). Assignments that wait for a
manual handoff get their packet too. `--json` prints the packet itself, with format
characters escaped.

Both refuse a packet in any of these cases:

- it is expired or altered;
- it names another run or recipient than the manifest reference;
- it was created more than 5 minutes in the future, which points at a wrong clock.

## Local evidence and retention

All run evidence is local and owner-private: manifests, events, approval records and
handoff packets live under `~/.code-conductor/runs` (or `$CODE_CONDUCTOR_HOME/runs`). There
is no central session database or service.

- `ccon runs` lists stored runs with their decision, age and any live worktrees.
- `ccon runs --older-than <days>` previews which runs' evidence would be deleted, and
  `--apply` deletes it.
- Runs whose agent worktrees still exist are kept; review or remove those worktrees first
  ([`WORKTREES.md`](WORKTREES.md)). Runs whose manifest cannot be read are kept too,
  because whether a worktree still uses them is unknown. Retention never touches
  worktrees or branches.

Nothing is deleted automatically. How long to keep evidence is your decision.
