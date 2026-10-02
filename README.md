# amp-orchestrator

Amp-native agent orchestration: **Lead** modes that route bounded outcomes to
**Peer** threads, advisory **Supervisor** modes, and a small inbox toolset to
create, message, wait on, and track those peers.

Every role is available on every model — four models × three roles = twelve
modes, so a Lead, its Peers, and a Supervisor can each run on a different model.

It is a single Amp directory plugin. There is no external daemon and no control
plane — peers are ordinary Amp threads, and the orchestration tools wrap Amp's
own thread APIs.

## Requirements

- Amp CLI with the plugin API that supports `registerAgentMode` and
  `registerTool` (the `@ampcode/plugin` surface shown by `amp plugins show-docs`).
- Run Amp in a workspace so the peer registry has a home.

## Install

System scope (this machine, all repos):

```sh
./install.sh          # copies this plugin into ~/.config/amp/plugins/amp-orchestrator
```

Then reload plugins (`plugins: reload` in the command palette) or restart Amp.
After editing the repo, re-run `./install.sh --force` to refresh the installed
copy.

Personal/global scope (every machine): add this directory to your Personal
Plugins repository, or point `amp plugins add` at it.

> Amp does not follow a symlinked plugin directory, so the installer copies. The
> plugin directory **must be named `amp-orchestrator`**: the tools are granted by
> the glob `plugin__amp-orchestrator__*`.

## Use

Start a thread in a **Lead** mode (e.g. `Lead - GPT Luna`) and give it a
project-level request. The Lead will preflight, then spawn Peers for bounded
outcomes — pick each Peer's model with the `model` argument of `peer_spawn`.
Open a **Supervisor** thread yourself if you want an advisor watching.

### Modes

Every role is registered once per model. Keys are `<role>-<model>`; labels are
`<Role> - <Model short name>`.

| Role | Keys | Extends | Purpose |
| --- | --- | --- | --- |
| Lead | `lead-gpt`, `lead-deepseek`, `lead-glm`, `lead-glm-flash` | `high` | Framing, routing, integration, verification, acceptance. |
| Peer | `peer-gpt`, `peer-deepseek`, `peer-glm`, `peer-glm-flash` | `medium` | Owns one bounded outcome; reports evidence. |
| Supervisor | `supervisor-gpt`, `supervisor-deepseek`, `supervisor-glm`, `supervisor-glm-flash` | `medium` | Advisory delivery-quality observation; no project ownership. |

Models:

| Model slug | Model | Reasoning |
| --- | --- | --- |
| `gpt` | `openai/gpt-5.6-luna` | Lead `max` · Peer/Supervisor `high` |
| `deepseek` | `deepseek/deepseek-v4.1-flash` | Lead `max` · Peer/Supervisor `high` |
| `glm` | `zhipuai/glm-5.3` | Lead `max` · Peer/Supervisor `high` |
| `glm-flash` | `zhipuai/glm-5.3-flash` | Lead `max` · Peer/Supervisor `high` |

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
