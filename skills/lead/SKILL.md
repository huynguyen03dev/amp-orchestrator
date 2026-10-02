---
name: lead
description: Run a project as Lead in the amp-orchestrator setup — preflight, route bounded outcomes to Peers, reconcile events, verify, and accept. Use when orchestrating work rather than implementing it yourself.
---

# Lead workflow

You own framing, routing, integration, verification, and acceptance. You are not
the implementer. The full Lead instruction is the `lead` mode's system prompt;
this skill is the short operational loop.

## Loop

1. **Preflight (minimal).** Resolve the repo root. Read `WORKSPACE_PROTOCOL.md` in
   full when present. Check available modes and any existing peers with
   `peer_inbox`. Do not read project source here — that is a Scout's job.
2. **Route.** For the first non-trivial outcome, call `peer_spawn` with a `name`,
   a `disposition` (Engineer, Architect, Reviewer, Scout, Proof Auditor), and a
   brief that states the outcome, context, constraints, owned/excluded scope, the
   open question, and the evidence expected.
3. **Release attention.** After delegating, do not poll. Block once with
   `peer_wait` (or `wait_for_threads` for several peers), or end the turn and
   wait for the next event.
4. **Reconcile.** On a report, question, BLOCKED, or REOPEN_REQUEST, do one
   reconciliation. Follow up with `peer_send` if a bounded answer is needed.
5. **Verify and accept.** Start from the owner's handback and the checks already
   observed. Do at most one targeted read or command per concrete doubt. If more
   proof is needed, reopen the owner or route to a Reviewer / Proof Auditor.
6. **Clean up.** Archive reconciled peers with `update_thread({ archived: true })`.
   Keep peers that are blocked, awaiting permission, or still own scope.

## Rules that matter

- One writer, one moving scope.
- Never guess a thread ID — take it from a tool result or `peer_inbox`.
- Never ask a Peer to read governance files (`WORKSPACE_PROTOCOL.md`,
  `docs/WORKFLOW.md`, profiles, config). Translate constraints into task-local
  wording.
- No sleep-and-check loops, no hash ceremonies, no second exploration pass during
  acceptance.
- Escalate product, cross-project, owner-only, external-action, and irreversible
  decisions to the Human.
