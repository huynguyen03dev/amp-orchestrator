# Design

## Goal

Reproduce the Lead / Peer / Supervisor model natively in Amp: one accountable Lead
routes bounded outcomes to independent Peer threads, verifies their evidence, and
accepts — without an external control plane.

## Why this is Amp-native

Amp already has the primitives a control plane would otherwise provide:

| Control-plane concept | Amp primitive used here |
| --- | --- |
| agent registry | the persisted registry + `agent_inbox` |
| run an agent with a role profile | `Agent.createThread()` + a mode (`peer`) |
| send a task to an agent | `PluginThread.appendUserMessage()` |
| report a finished turn to its owner | `agent.end` → `appendUserMessage()` on the owner |
| stop a misdirected agent | `agent_cancel` |
| archive an agent | `update_thread({ archived: true })` |

So the plugin is thin: it defines three roles and four tools, and delegates the
actual execution to Amp's thread machinery.

## Components

```
index.ts
  ├─ readProfile('lead' | 'peer' | 'supervisor')  → createAgent({ instructions })
  ├─ registerAgentMode(lead | peer | supervisor)
  ├─ registerTool(peer_spawn | lead_spawn | agent_inbox | agent_cancel)
  └─ amp.on('session.start' | 'agent.end' | 'tool.call')

lib/registry.ts   persisted index: id, role, name, status, last report, spawnedBy
```

### Modes

Every role is registered once per model (5 models × 3 roles, plus a Lead-only model
= 16 modes), so a Lead, its Peers, and a Supervisor can run on different models. A
mode key is `<role>-<model>` and pins `model` explicitly; each still extends a
built-in mode so the prompt and tool tuning stay consistent with Amp:

- **Lead** extends `high`, gets `peer_spawn` plus the generic tools, uses the Lead
  instruction, and runs at `max` effort. It cannot create a Lead.
- **Peer** extends `medium` and gets no orchestrator tools, so it can never
  recursively spawn.
- **Supervisor** extends `medium`, gets `lead_spawn` plus the generic tools,
  excludes the file write tools, and runs at `high` effort. It creates a successor
  Lead for recovery but does not own project work.

Spawn tools pick the model via their `model` argument, so the Lead and the
Supervisor can each place an agent on any configured model.

### Tools

`peer_spawn` (Lead) and `lead_spawn` (Supervisor) are the only tools that create a
thread. The rest operate on an existing thread ID.

### Registry

The registry is a best-effort index keyed by a hash of the workspace root, stored
under `~/.cache/amp/orchestrator/`. It answers "what agents do I have and what did
they last say" for `agent_inbox`, and records which thread spawned each agent. It
is never authoritative: the threads are.

## Event model

- **`session.start`** marks an agent thread as running.
- **`agent.end`** reports the settled turn (below) and refreshes the registry's
  last report.
- **`tool.call`** registers a one-shot reply when an agent messages a known agent
  thread, so that thread's next settle reports back to the sender.

### Reporting a settled turn

A thread reports **once**, to whoever last addressed it. The registration is set by
the spawn brief (the plugin appends it on the spawner's behalf) and by an agent's
own `send_thread_message` to a known agent thread; the settle consumes it. The
notice inlines the agent's closing text block, plus the thread URL.

This replaced two earlier mechanisms, deliberately:

- A **watchdog nudge** reopened a Lead or Peer thread and instructed it, with a
  regex on shell command names deciding what counted as verification. That
  pre-solved the work for the agent, trained the very verification ritual the
  Supervisor exists to catch, and let a third party redirect a scope the Lead owns
  without the Lead knowing a direction change had happened.
- A **heuristic Supervisor wake** escalated single events (turn status, handback
  markers) to the Supervisor, whose mandate is cross-scope drift over time. Wrong
  kind of signal — and the settle report already delivers the same material to the
  agent's owner.

The plugin now cannot return a `continue` action at all, so it cannot reopen,
correct, or redirect a thread. Judging the work belongs to the Supervisor, which
does that by reading on a schedule the Human sets rather than by reacting to
heuristics here.

## Limits and non-goals

- No cross-machine scheduling: agents run on the same executor as the spawner.
- No durable orchestration state machine: if an agent is lost, the owner reconciles
  from `agent_inbox` and the thread itself.
- No automatic acceptance: the Lead decides; the plugin only moves messages.
- No code judgement: the plugin never assesses quality, scope, or verification.
- Not a sandbox: agents inherit the executor's permissions.
