# amp-orchestrator

Amp-native agent orchestration: **Lead** modes that route bounded outcomes to
**Peer** threads, advisory **Supervisor** modes, and a small inbox toolset to
create, message, wait on, and track those peers.

Every role is available on every model — five models × three roles, plus a
Lead-only model, gives sixteen modes, so a Lead, its Peers, and a Supervisor can
each run on a different model.

It is a single Amp directory plugin. There is no external daemon and no control
plane — peers are ordinary Amp threads, and the orchestration tools wrap Amp's
own thread APIs.

## Requirements

- Amp CLI with the plugin API that supports `registerAgentMode` and
  `registerTool` (the `@ampcode/plugin` surface shown by `amp plugins show-docs`).
- Run Amp in a workspace so the peer registry has a home.

## Install

Personal scope — **everywhere you use Amp** (all machines and orbs). Recommended:

```sh
./publish.sh          # copies into your Personal Plugins checkout and pushes
```

Then reload plugins (`plugins: reload` in the command palette) or restart the
runner.

System scope — this machine only:

```sh
./install.sh          # copies into ~/.config/amp/plugins/amp-orchestrator
```

System plugins apply only on the machine where they are installed, and they take
precedence over a Personal Plugin of the same name — so install one or the other,
not both, or the copies can drift.

> The plugin directory **must be named `amp-orchestrator`**: the tools are granted
> by the glob `plugin__amp-orchestrator__*`. Amp does not follow a symlinked
> plugin directory, so both scripts copy rather than link.

## Use

Start a thread in a **Lead** mode (e.g. `SLP/Lead GPT Luna`) and give it a
project-level request. The Lead will preflight, then spawn Peers for bounded
outcomes — pick each Peer's model with the `model` argument of `peer_spawn`.
Open a **Supervisor** thread yourself if you want an advisor watching.

### Modes

Every role is registered once per model. Keys are `<role>-<model>`; labels are
`SLP/<Role> <Model short name>`, so the whole set filters on the `SLP` prefix.

| Role | Keys | Extends | Purpose |
| --- | --- | --- | --- |
| Lead | `lead-gpt`, `lead-deepseek`, `lead-glm`, `lead-glm-flash`, `lead-gemini`, `lead-sol` | `high` | Framing, routing, integration, verification, acceptance. |
| Peer | `peer-gpt`, `peer-deepseek`, `peer-glm`, `peer-glm-flash`, `peer-gemini` | `medium` | Owns one bounded outcome; reports evidence. |
| Supervisor | `supervisor-gpt`, `supervisor-deepseek`, `supervisor-glm`, `supervisor-glm-flash`, `supervisor-gemini` | `medium` | Advisory delivery-quality observation; no project ownership. |

Models:

| Model slug | Model | Reasoning |
| --- | --- | --- |
| `gpt` | `openai/gpt-5.6-luna` | Lead `max` · Peer/Supervisor `high` |
| `deepseek` | `deepseek/deepseek-v4.1-flash` | Lead `max` · Peer/Supervisor `high` |
| `glm` | `zhipuai/glm-5.3` | Lead `max` · Peer/Supervisor `high` |
| `glm-flash` | `zhipuai/glm-5.3-flash` | Lead `max` · Peer/Supervisor `high` |
| `gemini` | `google/gemini-3.8-flash` | Lead `max` · Peer/Supervisor `high` |
| `sol` | `openai/gpt-6.1-sol` | Lead `low` — **Lead only** (expensive) |

A model may be restricted to some roles with a `roles` list, and override the
role's reasoning effort with `effort`, on its `MODELS` entry. `sol` is Lead-only
at `low` effort, so it has no Peer or Supervisor mode and `peer_spawn` never
offers it.

### Tools

| Tool | Who | Does |
| --- | --- | --- |
| `peer_spawn` | Lead | Create a Peer thread (choose `model`), send it a brief, return its thread ID. |
| `lead_spawn` | Supervisor | Create a successor Lead thread for a bounded recovery handoff. |
| `agent_send` | Lead + Supervisor | Append a follow-up message to a spawned agent thread. |
| `agent_wait` | Lead + Supervisor | Block once until an agent finishes a turn; return its reply. |
| `agent_status` | Lead + Supervisor | Read an agent's activity state and recent messages. |
| `agent_inbox` | Lead + Supervisor | List every agent this thread spawned, with status and latest report. |

A Peer gets none of these, so it can never recursively spawn. A Lead cannot create
a Lead — a project has exactly one Lead; only a Supervisor creates a successor
Lead. Each spawned agent is a **separate Amp thread** (a child of the spawning
thread), with its own `T-...` ID, transcript, and URL.

The Lead also keeps Amp's own thread tools (`create_thread`,
`send_thread_message`, `wait_for_threads`, `get_thread_status`,
`update_thread`), so it can archive a reconciled agent with
`update_thread({ archived: true })`.

## Course-correction (watchdog)

The plugin watches every Lead and Peer turn on its runner (`agent.end`) and reacts
in two ways:

- **Nudge (mechanical).** An unambiguous rule violation — files changed with no
  verification command run, or the same tool failing three times in one turn —
  returns `continue` with a short correction sent straight back into that thread.
  No Supervisor turn is spent.
- **Wake the Supervisor (judgement).** A turn that ends in `error` / `cancelled`,
  or a report that hands back `BLOCKED` / `REOPEN_REQUEST` / `DEPENDENCY_REQUEST`,
  appends a digest to the Supervisor thread, which wakes it to decide.

Both are throttled (nudge ≤ once per thread per 90s, Supervisor wake ≤ once per
thread per 10 min) and the watchdog never reacts to its own nudge turn. The
Supervisor must have been opened at least once on that runner so the plugin knows
its thread; without one, judgement signals are dropped rather than guessed.

## Customize

The mode system prompts are the only guidance source — the plugin registers no
skills. They are read from these files at plugin load:

- `profiles/lead.md`
- `profiles/peer.md`
- `profiles/supervisor.md`

After editing, run `plugins: reload`.

## Layout

```
amp-orchestrator/
├── index.ts              # plugin entry: modes + tools
├── lib/registry.ts       # persisted peer index (for peer_inbox)
├── profiles/             # mode system prompts (source of truth)
├── docs/DESIGN.md        # architecture and limits
└── install.sh
```

## Caveats

- Spawned agents are real Amp threads: they consume credits/tokens and appear in
  your thread list. Archive them when reconciled.
- The peer registry is a convenience index persisted under
  `~/.cache/amp/orchestrator/`; the threads themselves are the source of truth.
- `peer_wait` and `wait_for_threads` block. Prefer one blocking wait per event
  over polling loops.
- The plugin runs on the thread's executor (runner or orb). In-memory state does
  not survive a runner restart; the on-disk registry does.
