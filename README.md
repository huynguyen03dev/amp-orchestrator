# amp-orchestrator

Amp-native agent orchestration: a **Lead** mode that routes bounded outcomes to
**Peer** threads, an advisory **Supervisor** mode, and a small inbox toolset to
create, message, wait on, and track those peers.

It is a single Amp directory plugin. There is no external daemon and no control
plane — peers are ordinary Amp threads, and the orchestration tools wrap Amp's
own thread APIs.

## Requirements

- Amp CLI with the plugin API that supports `registerAgentMode`, `registerTool`,
  and `registerSkill` (the `@ampcode/plugin` surface shown by
  `amp plugins show-docs`).
- Run Amp in a workspace so the peer registry has a home.

## Install

System scope (this machine, all repos):

```sh
./install.sh          # symlinks this directory into ~/.config/amp/plugins/amp-orchestrator
```

Then reload plugins (`plugins: reload` in the command palette) or restart Amp.

Personal/global scope (every machine): add this directory to your Personal
Plugins repository, or point `amp plugins add` at it.

> The plugin directory **must be named `amp-orchestrator`**: the Lead mode grants
> its tools by the glob `plugin__amp-orchestrator__*`.

## Use

Start a thread in the **Lead** mode and give it a project-level request. The Lead
will preflight, then spawn Peers for bounded outcomes. Peers run in the **Peer**
mode (the Lead creates those threads for you). Open a **Supervisor** thread
yourself if you want an advisor watching.

### Modes

| Mode | Key | Extends | Purpose |
| --- | --- | --- | --- |
| Lead | `lead` | `high` | Framing, routing, integration, verification, acceptance. |
| Peer | `peer` | `medium` | Owns one bounded outcome; reports evidence. |
| Supervisor | `supervisor` | `medium` | Advisory delivery-quality observation; no project ownership. |

### Tools (Lead only)

| Tool | Does |
| --- | --- |
| `peer_spawn` | Create a Peer thread, send it a brief, return its thread ID. |
| `peer_send` | Append a follow-up message to a Peer thread. |
| `peer_wait` | Block once until a Peer finishes a turn; return its reply. |
| `peer_status` | Read a Peer's activity state and recent messages. |
| `peer_inbox` | List every Peer this Lead spawned, with status and latest report. |

The Lead also keeps Amp's own thread tools (`create_thread`,
`send_thread_message`, `wait_for_threads`, `get_thread_status`,
`update_thread`), so it can archive a reconciled peer with
`update_thread({ archived: true })`.

## Customize

Edit the instruction profiles — the mode system prompts are read from them at
plugin load:

- `profiles/lead.md`
- `profiles/peer.md`
- `profiles/supervisor.md`

The skills under `skills/` are the short operational loops and are registered as
`amp-orchestrator:lead`, `amp-orchestrator:peer`, `amp-orchestrator:supervisor`.

After editing, run `plugins: reload`.

## Layout

```
amp-orchestrator/
├── index.ts              # plugin entry: modes + tools + skills
├── lib/registry.ts       # persisted peer index (for peer_inbox)
├── profiles/             # mode system prompts (source of truth)
├── skills/               # bundled skills (lead / peer / supervisor)
├── docs/DESIGN.md        # architecture and limits
└── install.sh
```

## Caveats

- Peers are real Amp threads: they consume credits/tokens and appear in your
  thread list. Archive them when reconciled.
- The peer registry is a convenience index persisted under
  `~/.cache/amp/orchestrator/`; the threads themselves are the source of truth.
- `peer_wait` and `wait_for_threads` block. Prefer one blocking wait per event
  over polling loops.
- The plugin runs on the thread's executor (runner or orb). In-memory state does
  not survive a runner restart; the on-disk registry does.
