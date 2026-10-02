# Design

## Goal

Reproduce the Lead / Peer / Supervisor orchestration model natively in Amp: one
accountable Lead routes bounded outcomes to independent Peer threads, verifies
their evidence, and accepts — without an external control plane.

## Why this is Amp-native

Amp already has the primitives a control plane would otherwise provide:

| Paseo concept | Amp primitive used here |
| --- | --- |
| daemon + agent registry | Amp threads; the Lead's peer index |
| `run` an agent with a role profile | `Agent.createThread()` + a mode (`peer`) |
| `send` a task to an agent | `PluginThread.appendUserMessage()` |
| `wait` for an agent | `PluginThread.waitForResponse()` |
| inbox / completion events | `peer_inbox`, `thread.state`, `agent.end` |
| archive an agent | `update_thread({ archived: true })` |
| role profiles | mode system prompts (`profiles/*.md`) |

So the plugin is thin: it defines three modes and five tools, and delegates the
actual execution to Amp's thread machinery.

## Components

```
index.ts
  ├─ readProfile('lead' | 'peer' | 'supervisor')  → createAgent({ instructions })
  ├─ registerAgentMode(lead | peer | supervisor)
  └─ registerTool(peer_spawn | lead_spawn | agent_send | agent_wait | agent_status | agent_inbox)

lib/registry.ts   persisted index: id, name, disposition, status, last report
```

### Modes

Every role is registered once per model (4 models × 3 roles = 12 modes), so a
Lead, its Peers, and a Supervisor can run on different models. A mode key is
`<role>-<model>` and pins `model` explicitly; each still extends a built-in mode
so the prompt and tool tuning stay consistent with Amp:

- **Lead** extends `high`, gets `peer_spawn` plus the generic agent tools, uses
  the Lead instruction, and runs at `max` effort. It cannot create a Lead.
- **Peer** extends `medium` and gets no orchestrator tools, so it can never
  recursively spawn.
- **Supervisor** extends `medium`, gets `lead_spawn` plus the generic agent tools,
  excludes the file write tools, and runs at `high` effort. It creates a
  successor Lead for recovery but does not own project work.

Spawn tools pick the model via their `model` argument, so the Lead and the
Supervisor can each place an agent on any configured model.

### Tools

`peer_spawn` (Lead) and `lead_spawn` (Supervisor) are the only tools that create
a thread. The rest operate on an existing thread ID. `agent_wait` maps directly
to `waitForResponse`, which resolves when the thread returns to `idle` after a
turn and rejects on `error` or timeout.

### Registry

The registry is a best-effort index keyed by a hash of the workspace root, stored
under `~/.cache/amp/orchestrator/`. It exists so `peer_inbox` can answer "what
peers do I have and what did they last say" without scanning every thread. It is
never authoritative: the threads are.

## Event model

The Lead's instruction forbids sleep-and-poll. The intended loops are:

- **Block once**: `peer_wait` (one peer) or `wait_for_threads` (several).
- **Turn-driven**: end the turn; the next event is a new user message or a peer
  completion surfaced by the client.
- **Hook-driven** (future): a plugin `agent.end` handler could inject a
  continuation when a peer reports, and `createWebhook` could accept external
  completions. These are deliberately not implemented in v1 to keep the failure
  modes small.

## Limits and non-goals

- No cross-machine scheduling: peers run on the same executor as the Lead.
- No durable orchestration state machine: if a peer is lost, the Lead reconciles
  from `peer_inbox` and `peer_status`.
- No automatic acceptance: the Lead decides; the plugin only moves messages.
- Not a sandbox: Peers inherit the executor's permissions.
