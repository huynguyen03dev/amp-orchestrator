# amp-orchestrator

Amp-native agent orchestration: **Lead** modes that route bounded outcomes to
**Peer** threads, advisory **Supervisor** modes, and a small toolset to create,
track, and archive those agents.

Every role is available on every model — five models × three roles, plus a
Lead-only model, gives sixteen modes, so a Lead, its Peers, and a Supervisor can
each run on a different model.

It is a single Amp directory plugin. There is no external daemon and no control
plane — agents are ordinary Amp threads, and the tools wrap Amp's own thread APIs.

## What the plugin does, and what it refuses to do

The plugin moves messages and keeps an index. It does not judge the work.

- **It reports a settled turn.** When an agent finishes a turn, its closing output
  is appended to the thread that last addressed it, so the recipient can act
  without reading the agent's thread.
- **It never corrects, reopens, or redirects a thread.** The plugin cannot return
  a `continue` action, so it can never instruct an agent or change a direction
  behind the Lead's back. Judging the quality of the work belongs to the
  Supervisor, which reads threads on a schedule the Human sets.

## Requirements

- Amp CLI with the plugin API that supports `registerAgentMode` and
  `registerTool` (the `@ampcode/plugin` surface shown by `amp plugins show-docs`).
- Run Amp in a workspace so the agent registry has a home.

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
project-level request. The Lead preflights, then spawns Peers for bounded
outcomes — pick each Peer's model with the `model` argument of `peer_spawn`.

After handing a Peer an outcome the Lead ends its turn. It does not wait and does
not poll: when the Peer settles, its report arrives in the Lead's thread on its
own. The Lead reconciles, then either routes the next bounded outcome or ends its
turn again.

A **Supervisor** is advisory and Human-facing. Open a Supervisor thread yourself
and set a schedule on it — the plugin never creates schedules, and the Supervisor
does not set its own. On each scheduled wake it reads what the work actually did
and decides whether to intervene. Out of band it hears from a Lead only when it
addresses one: the brief it hands a new Lead, or any later message it sends, is
answered once when that Lead next settles.

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
| `agent_inbox` | Lead + Supervisor | List every agent this thread spawned, with status and latest report. |
| `agent_cancel` | Lead + Supervisor | Stop a runaway or misdirected agent turn. |

A Peer gets none of these, so it can never recursively spawn. A Lead cannot create
a Lead — a project has exactly one Lead; only a Supervisor creates a successor
Lead. Each spawned agent is a **separate Amp thread** (a child of the spawning
thread), with its own `T-...` ID, transcript, and URL.

Both the Lead and the Supervisor keep Amp's own thread tools
(`send_thread_message`, `get_thread_status`, `find_thread`, `update_thread`), so a
Lead can archive a reconciled agent with `update_thread({ archived: true })`.

### Reporting a settled turn

On every `agent.end` the plugin asks one question: does this thread owe someone a
report? A thread reports **once**, to whoever last addressed it. The plugin
registers that when it hands a new agent its brief, and when an agent messages a
known agent thread with `send_thread_message`. The settle consumes the
registration, so later turns stay silent until someone addresses the thread again.

The notice carries the agent's **closing text block** — the outcome it stated
last, not the whole turn's narration — plus the thread URL as the escape hatch for
the full transcript. Reports longer than 6,000 characters are truncated.

A human typing into a thread is not a tool call, so it never puts a thread on a
reporting loop.

## Customize

The mode system prompts are the only guidance source — the plugin registers no
skills. They are read from these files at plugin load:

- `profiles/lead.md`
- `profiles/peer.md`
- `profiles/supervisor.md`

Also in `index.ts`:

- `MODELS` / `ROLES` — the mode matrix, per-model `roles` and `effort` overrides.
- `ORACLE_PIN` — the Oracle model and effort for roles that keep the Oracle tool.
- `SUBAGENT_PIN` — the subagent model and effort for every role.
- `DISABLED_SUBAGENTS` — subagents no role may use (`painter`, `Task`), which keeps
  delegation explicit: a Lead routes to a Peer through `peer_spawn` rather than
  spinning up an ad-hoc `Task` subagent.
- `REPORT_INLINE_LIMIT` — how much of a settled agent's output is inlined.

After editing, run `plugins: reload`.

## Layout

```
amp-orchestrator/
├── index.ts              # plugin entry: modes, tools, the settle report
├── lib/registry.ts       # persisted agent index (for agent_inbox)
├── profiles/             # mode system prompts (source of truth)
├── docs/DESIGN.md        # architecture and limits
├── README.md
├── install.sh
└── publish.sh
```

## Caveats

- Spawned agents are real Amp threads: they consume credits/tokens and appear in
  your thread list. Archive them when reconciled.
- The agent registry is a convenience index persisted under
  `~/.cache/amp/orchestrator/`, keyed by a hash of the workspace root; the threads
  themselves are the source of truth.
- `wait_for_threads` still exists in Amp and stays available to the roles, but
  nothing here needs it: every agent a role can create reports back on its own.
  It is useful only for a thread the plugin did not spawn, which no event reports.
- The plugin runs on the thread's executor (runner or orb). In-memory state does
  not survive a runner restart; the on-disk registry does.
- A runner caches mode definitions until it restarts. `plugins: reload` picks up a
  changed plugin in the running session, but a restart is what makes one version
  uniform across every workspace host on that runner.
