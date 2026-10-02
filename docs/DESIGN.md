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
  └─ registerTool(peer_spawn | peer_send | peer_wait | peer_status | peer_inbox)

lib/registry.ts   persisted index: id, name, disposition, status, last report
```

### Modes

- **Lead** extends `high`, adds the orchestrator tools, and uses the Lead
  instruction. Extending a built-in mode keeps the model/prompt/tools tuning
  consistent with the rest of Amp; the user can re-tune the model through the
  Mode Dial.
- **Peer** extends `medium` and excludes the orchestrator tools so a Peer cannot
  recursively spawn peers.
- **Supervisor** extends `medium`, excludes the orchestrator tools and the file
  write tools so it stays advisory.

### Tools

`peer_spawn` is the only tool that creates a thread. The rest operate on an
existing thread ID. `peer_wait` maps directly to `waitForResponse`, which
resolves when the thread returns to `idle` after a turn and rejects on `error` or
timeout.

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
