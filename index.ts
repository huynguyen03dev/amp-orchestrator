// @amp-agent-mode {"key":"lead-gpt","label":"SLP/Lead GPT Luna","color":"#d97706"}
// @amp-agent-mode {"key":"lead-deepseek","label":"SLP/Lead DeepSeek","color":"#d97706"}
// @amp-agent-mode {"key":"lead-glm","label":"SLP/Lead GLM 5.3","color":"#d97706"}
// @amp-agent-mode {"key":"lead-glm-flash","label":"SLP/Lead GLM Flash","color":"#d97706"}
// @amp-agent-mode {"key":"lead-gemini","label":"SLP/Lead Gemini 3.8","color":"#d97706"}
// @amp-agent-mode {"key":"lead-sol","label":"SLP/Lead GPT-6.1 Sol","color":"#d97706"}
// @amp-agent-mode {"key":"peer-gpt","label":"SLP/Peer GPT Luna","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-deepseek","label":"SLP/Peer DeepSeek","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-glm","label":"SLP/Peer GLM 5.3","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-glm-flash","label":"SLP/Peer GLM Flash","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-gemini","label":"SLP/Peer Gemini 3.8","color":"#2563eb"}
// @amp-agent-mode {"key":"supervisor-gpt","label":"SLP/Sup GPT Luna","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-deepseek","label":"SLP/Sup DeepSeek","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-glm","label":"SLP/Sup GLM 5.3","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-glm-flash","label":"SLP/Sup GLM Flash","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-gemini","label":"SLP/Sup Gemini 3.8","color":"#64748b"}
import { readFileSync } from 'node:fs'
import type {
	Agent,
	AgentEndEvent,
	AgentReasoningEffort,
	AgentSubagentPin,
	AgentToolSelection,
	PluginAPI,
	PluginThread,
	PluginToolContext,
	ThreadID,
} from '@ampcode/plugin'
import { AgentRegistry, type AgentRecord } from './lib/registry'

/**
 * Orchestration tools, by their bare registered name.
 *
 * `tools.exclude` matches these ONLY as bare names. Amp's documented
 * `plugin__<pluginName>__<toolName>` form and the scoped glob
 * `plugin__<pluginName>__*` do not match this plugin's own tools, so using them
 * silently leaves every role holding every spawn tool.
 *
 * Verified 2026-10-04 on a freshly restarted runner, with `shell_command` as a
 * freshness control (it must disappear, proving the runner used this file):
 *   exclude ['plugin__amp-orchestrator__*']                     -> tools kept
 *   exclude ['peer_spawn', 'lead_spawn', 'agent_inbox', ...]    -> tools removed
 *   exclude ['plugin__*']                                       -> tools removed
 * `exclude` always wins over `add`, so `plugin__*` cannot be paired with `add`
 * to re-grant a single tool; exclude only what the role must not have.
 */
const ORCHESTRATOR_TOOLS = ['peer_spawn', 'lead_spawn', 'agent_inbox', 'agent_cancel'] as const
/** Visible prefix on every orchestration mode, so they filter together. */
const MODE_PREFIX = 'SLP/'

/** Orchestration tools both the Lead and the Supervisor get. */
const GENERIC_AGENT_TOOLS = ['agent_inbox', 'agent_cancel'] as const

/**
 * Subagents no orchestration role may use.
 *
 * - `painter` is expensive and no role needs image generation.
 * - `Task` is the general-purpose subagent runner. Excluding it keeps delegation
 *   explicit in SLP: a Lead routes work to a Peer through `peer_spawn` instead of
 *   quietly spinning up an ad-hoc Task subagent. `librarian` and `finder` stay
 *   available for read-only research.
 */
const DISABLED_SUBAGENTS = ['painter', 'Task'] as const

/**
 * Default Oracle pin for roles that keep the Oracle tool, on the user's own
 * cheaper connection. A model pin on the specific mode wins over this one
 * (`lead-sol` pins Sol). An unavailable model falls back to Amp's automatic
 * routing at run time.
 */
const ORACLE_PIN = { model: 'zhipuai/glm-5.3', effort: 'high' } as const

/**
 * Subagent pin for every role. With `Task` excluded, the only subagents left are
 * `librarian` and `finder` — read-only research — so a light model is enough.
 * `lead-sol` overrides this with Luna at max effort.
 */
const SUBAGENT_PIN = { model: 'deepseek/deepseek-v4.1-flash', effort: 'high' } as const

const readProfile = (name: string): string =>
	readFileSync(new URL(`./profiles/${name}.md`, import.meta.url), 'utf8').trim()

const LEAD_PROMPT = readProfile('lead')
const PEER_PROMPT = readProfile('peer')
const SUPERVISOR_PROMPT = readProfile('supervisor')

/**
 * The first line of each profile is its role sentinel. Amp exposes a thread's
 * instructions but not its registered mode key, so this heading is the only stable
 * identifier available: matching the whole text instead would stop recognising every
 * already-running thread the moment a profile body is reworded.
 */
const ROLE_HEADINGS = [
	['# Lead', 'lead'],
	['# Peer', 'peer'],
	['# Supervisor', 'supervisor'],
] as const

/** A model every role can be pinned to. Models must be served by a user connection. */
interface ModelSpec {
	slug: string
	model: string
	short: string
	/** Roles this model is available for. Omit for every role. */
	roles?: readonly string[]
	/** Reasoning effort override for this model. Omit to use the role's effort. */
	effort?: AgentReasoningEffort
	/** Oracle pin for modes on this model. Falls back to the role's pin. */
	oracle?: AgentSubagentPin
	/** Subagent pin for modes on this model. Falls back to the role's pin. */
	subagents?: AgentSubagentPin
}

/** A role every model can be pinned to. */
interface RoleSpec {
	slug: string
	/** Full role name, used in descriptions. */
	label: string
	/** Compact role name used in the mode label. */
	short: string
	color: string
	extends?: 'low' | 'medium' | 'high' | 'ultra'
	effort: AgentReasoningEffort
	instructions: string
	tools: AgentToolSelection
	/** Subagent pin for this role's Oracle. Omit for a role without the Oracle tool. */
	oracle?: AgentSubagentPin
	/** Subagent pin for this role's Task/finder/librarian subagents. */
	subagents?: AgentSubagentPin
	description: (model: ModelSpec) => string
}

const MODELS: ModelSpec[] = [
	{ slug: 'gpt', model: 'openai/gpt-5.6-luna', short: 'GPT Luna' },
	{ slug: 'deepseek', model: 'deepseek/deepseek-v4.1-flash', short: 'DeepSeek' },
	{
		slug: 'glm',
		model: 'zhipuai/glm-5.3',
		short: 'GLM 5.3',
		// GLM 5.3 is the cheapest reasoner here, so its Lead consults Sol at
		// medium effort for the Oracle rather than a model of its own class.
		oracle: { model: 'openai/gpt-6.1-sol', effort: 'medium' },
	},
	{ slug: 'glm-flash', model: 'zhipuai/glm-5.3-flash', short: 'GLM Flash' },
	{ slug: 'gemini', model: 'google/gemini-3.8-flash', short: 'Gemini 3.8' },
	// Expensive: reserve it for the Lead role only, and keep effort low — it is strong as-is.
	{
		slug: 'sol',
		model: 'openai/gpt-6.1-sol',
		short: 'GPT-6.1 Sol',
		roles: ['lead'],
		effort: 'low',
		// The strongest reasoner here, so it consults itself for the Oracle, and
		// uses Luna at max effort for its read-only subagents (librarian, finder).
		oracle: { model: 'openai/gpt-6.1-sol', effort: 'high' },
		subagents: { model: 'openai/gpt-5.6-luna', effort: 'max' },
	},
]

/**
 * Tool selection per role.
 *
 * - Lead: keeps `peer_spawn` plus the generic agent tools, and cannot create a
 *   Lead, so a project has exactly one Lead at a time.
 * - Supervisor: keeps `lead_spawn` (successor Lead for recovery) plus the
 *   generic agent tools, and cannot create a Peer, consult an Oracle, or edit
 *   files — it only observes and intervenes.
 * - Peer: keeps no orchestrator tool at all (so it can never recursively spawn)
 *   and no Oracle subagent, so it forms its own technical judgment.
 *
 * These bind only because the exclude lists use bare tool names; see
 * ORCHESTRATOR_TOOLS above for why the qualified form does not work.
 */
const ROLES: RoleSpec[] = [
	{
		slug: 'lead',
		label: 'Lead',
		short: 'Lead',
		color: '#d97706',
		// EXPERIMENT: no `extends`, so LEAD_PROMPT is the system prompt rather than
		// agent instructions appended under the built-in 'high' prompt. Nine cold
		// runs showed the profile never wins the routing decision while it is
		// subordinate; this tests whether that hierarchy is the cause.
		effort: 'max',
		instructions: LEAD_PROMPT,
		tools: {
			add: ['peer_spawn', ...GENERIC_AGENT_TOOLS],
			exclude: ['lead_spawn', ...DISABLED_SUBAGENTS],
		},
		oracle: ORACLE_PIN,
		subagents: SUBAGENT_PIN,
		description: (m) =>
			`Orchestrates Peers on ${m.short}: routes bounded outcomes, verifies, and accepts. Use to run a project.`,
	},
	{
		slug: 'peer',
		label: 'Peer',
		short: 'Peer',
		color: '#2563eb',
		extends: 'medium',
		effort: 'high',
		instructions: PEER_PROMPT,
		// Peer: no orchestrator tool, and no Oracle — a Peer forms its own
		// judgment instead of consulting a second opinion subagent.
		tools: { exclude: [...ORCHESTRATOR_TOOLS, 'oracle', ...DISABLED_SUBAGENTS] },
		subagents: SUBAGENT_PIN,
		description: (m) =>
			`Independent collaborator on ${m.short} that owns one bounded outcome. Normally created by a Lead.`,
	},
	{
		slug: 'supervisor',
		label: 'Supervisor',
		short: 'Sup',
		color: '#64748b',
		extends: 'medium',
		effort: 'high',
		instructions: SUPERVISOR_PROMPT,
		tools: {
			add: ['lead_spawn', ...GENERIC_AGENT_TOOLS],
			exclude: [
				'peer_spawn',
				'oracle',
				...DISABLED_SUBAGENTS,
				'edit_file',
				'create_file',
				'delete_file',
				'apply_patch',
			],
		},
		subagents: SUBAGENT_PIN,
		description: (m) =>
			`Advisory observer on ${m.short}. Can create a successor Lead for recovery; does not own project work.`,
	},
]

function str(input: Record<string, unknown>, key: string): string {
	const value = input[key]
	return typeof value === 'string' ? value.trim() : ''
}

/**
 * The message appended to the thread that spawned an agent once that agent
 * settles.
 *
 * The agent's closing output is inlined in full, deliberately: a truncated
 * handback is incomplete evidence, so the recipient goes and reads the whole
 * child thread instead — which costs far more context than the report itself.
 * The URL is the thread link, not an escape hatch for content held back here.
 */
function settledNotice(
	record: AgentRecord,
	status: AgentEndEvent['status'],
	report: string,
	url: string,
): string {
	return [
		`[${record.role} ${record.name} · ${record.disposition} · ${record.model} · ${status}]`,
		report.trim() || '(no text output this turn)',
		url,
	].join('\n\n')
}

/**
 * The agent's closing words: the last non-empty text block of the turn.
 *
 * Concatenating every text block of the last assistant message would drag
 * mid-turn narration ("Working on it.") into the parent's notice. When an agent
 * finishes it states the outcome last, and that closing statement is all the
 * parent needs to act on, so take only that block.
 */
function closingText(messages: AgentEndEvent['messages']): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.role !== 'assistant') continue
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j]
			if (block.type === 'text' && block.text.trim()) return block.text.trim()
		}
	}
	return ''
}

export default function (amp: PluginAPI) {
	const workspaceRoot = amp.system.workspaceRoot
	const registry = new AgentRegistry(
		workspaceRoot ? amp.helpers.filePathFromURI(workspaceRoot) : null,
	)

	// ── Modes: every model × every role it is allowed for ────────────────────
	// One agent handle per `<role>-<model>`, used by the spawn tools.
	const agents = new Map<string, Agent>()
	const modelsByRole = new Map<string, string[]>()

	for (const model of MODELS) {
		for (const role of ROLES) {
			if (model.roles && !model.roles.includes(role.slug)) continue
			const key = `${role.slug}-${model.slug}`
			const label = `${MODE_PREFIX}${role.short} ${model.short}`
			const oraclePin = model.oracle ?? role.oracle
			const subagentsPin = model.subagents ?? role.subagents
			const agent = amp.createAgent({
				...(role.extends ? { extends: role.extends } : {}),
				model: model.model,
				instructions: role.instructions,
				tools: role.tools,
				reasoningEffort: model.effort ?? role.effort,
				...(oraclePin ? { oracle: oraclePin } : {}),
				...(subagentsPin ? { subagents: subagentsPin } : {}),
				display: { label, color: role.color },
			})
			amp.registerAgentMode({
				key,
				label,
				description: role.description(model),
				color: role.color,
				agent: agent.definition,
			})
			agents.set(key, agent)
			modelsByRole.set(role.slug, [...(modelsByRole.get(role.slug) ?? []), model.slug])
		}
	}

	/** Model slugs allowed for a role, in `MODELS` order. */
	const modelsFor = (roleSlug: string): string[] => modelsByRole.get(roleSlug) ?? []

	/** Shared spawn: create a thread for `<role>-<model>` and send it the brief. */
	async function spawn(
		roleSlug: 'lead' | 'peer',
		input: Record<string, unknown>,
		ctx: PluginToolContext,
	): Promise<string> {
		const roleModels = modelsFor(roleSlug)
		const modelSlug = str(input, 'model') || roleModels[0]
		const name = str(input, 'name')
		const brief = str(input, 'brief')
		const disposition = str(input, 'disposition') || (roleSlug === 'lead' ? 'Lead' : 'Engineer')
		if (!name) throw new Error(`${roleSlug}_spawn requires a non-empty name`)
		if (!brief) throw new Error(`${roleSlug}_spawn requires a non-empty brief`)

		const agent = agents.get(`${roleSlug}-${modelSlug}`)
		if (!agent) {
			throw new Error(
				`Unknown model "${modelSlug}" for role ${roleSlug}. Models: ${roleModels.join(', ')}.`,
			)
		}

		const thread = await agent.createThread({ parentThreadID: ctx.thread.id })
		await thread.appendUserMessage({
			type: 'user-message',
			content: brief,
		})
		// The brief counts as this thread addressing the new agent, so its first
		// settle reports back here.
		expectReply(thread.id, ctx.thread.id)

		registry.upsert({
			id: thread.id,
			role: roleSlug,
			name,
			disposition,
			model: modelSlug,
			brief,
			spawnedBy: ctx.thread.id,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			lastStatus: 'running',
		})

		const url = new URL(`/threads/${thread.id}`, amp.system.ampURL).href
		return `Spawned ${roleSlug} "${name}" (${modelSlug}) → ${thread.id}\n${url}`
	}

	// ── Spawn tools (role-scoped) ────────────────────────────────────────────

	amp.registerTool({
		name: 'peer_spawn',
		title: 'Spawn peer',
		transcriptGroup: { active: 'Spawning peer', complete: 'Spawned peer' },
		description:
			'Create a new Peer thread that owns one bounded outcome, send it the brief, and return its thread ID. A Lead uses this for non-trivial work — implementation, fixes, reviews, scouting, research, architecture discovery — as its first substantive move, instead of reading the code itself. The Lead\'s own hands are for reconciliation, verification, and acceptance; a Peer that inherits the Lead\'s diagnosis is not independent.',
		inputSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Short handle, e.g. "scout-auth" or "impl-parser".',
				},
				disposition: {
					type: 'string',
					description: 'Engineer, Architect, Reviewer, Scout, or Proof Auditor.',
				},
				brief: {
					type: 'string',
					description:
						'Outcome, context, constraints, owned/excluded scope, open question, and evidence expected.',
				},
				model: {
					type: 'string',
					enum: modelsFor('peer'),
					description: `Model for the peer. One of: ${modelsFor('peer').join(', ')}. Defaults to "${modelsFor('peer')[0]}".`,
				},
			},
			required: ['name', 'disposition', 'brief'],
		},
		execute: (input, ctx) => spawn('peer', input, ctx),
	})

	amp.registerTool({
		name: 'lead_spawn',
		title: 'Spawn successor Lead',
		transcriptGroup: { active: 'Spawning Lead', complete: 'Spawned Lead' },
		description:
			'Create a successor Lead thread for a bounded recovery handoff, send it the brief, and return its thread ID. Each Lead runs in its own Amp thread.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Short handle for the new Lead.' },
				brief: {
					type: 'string',
					description:
						'Objective, current state, evidence, owned scope, and acceptance boundary for the handoff.',
				},
				model: {
					type: 'string',
					enum: modelsFor('lead'),
					description: `Model for the new Lead. One of: ${modelsFor('lead').join(', ')}. Defaults to "${modelsFor('lead')[0]}".`,
				},
			},
			required: ['name', 'brief'],
		},
		execute: (input, ctx) => spawn('lead', input, ctx),
	})

	// ── Generic agent tools (Lead and Supervisor) ────────────────────────────

	amp.registerTool({
		name: 'agent_cancel',
		title: 'Cancel agent',
		transcriptGroup: { active: 'Cancelling agent', complete: 'Cancelled agent' },
		description:
			"Interrupt an agent thread's current turn. Use to stop a runaway or misdirected agent; the thread stays available for follow-up.",
		inputSchema: {
			type: 'object',
			properties: {
				threadId: { type: 'string', description: 'Agent thread ID, e.g. T-...' },
			},
			required: ['threadId'],
		},
		async execute(input) {
			const threadId = str(input, 'threadId')
			if (!threadId) throw new Error('agent_cancel requires threadId')
			await amp.threads.get(threadId as ThreadID).cancel()
			registry.touch(threadId, 'cancelled')
			return `Cancelled the current turn of ${threadId}`
		},
	})

	amp.registerTool({
		name: 'agent_inbox',
		title: 'Agent inbox',
		transcriptGroup: { active: 'Reading inbox', complete: 'Read inbox' },
		description:
			'List every agent this thread spawned, with role, model, disposition, status, spawning thread, and the latest report.',
		inputSchema: { type: 'object', properties: {} },
		async execute(_input, ctx) {
			// A Lead sees the agents it routed work to. A Supervisor's mandate is
			// cross-scope, so it sees every agent in the workspace.
			const all = registry.list()
			const role = await roleOf(ctx.thread)
			const records = role === 'supervisor' ? all : all.filter((a) => a.spawnedBy === ctx.thread.id)
			if (records.length === 0) return 'No agents yet.'
			return records
				.map((a) => {
					const age = Math.round((Date.now() - a.updatedAt) / 1000)
					const report = a.lastReport ? `\n  last report: ${a.lastReport.slice(0, 600)}` : ''
					return `- ${a.role} "${a.name}" (${a.disposition} · ${a.model}) [${a.lastStatus}] ${a.id} ← ${a.spawnedBy} · ${age}s ago${report}`
				})
				.join('\n')
		},
	})

	// ── Thread roles ─────────────────────────────────────────────────────────
	// The plugin sees agent.end for every thread this runner hosts. It uses the
	// role only to decide what to record; it never corrects, reopens, or redirects
	// a thread. Judging the quality of the work belongs to the Supervisor, which
	// reads threads on its own schedule rather than reacting to heuristics here.
	const roleCache = new Map<string, string | null>()

	async function roleOf(thread: PluginThread): Promise<string | null> {
		const cached = roleCache.get(thread.id)
		if (cached !== undefined) return cached
		let role: string | null = null
		try {
			const agent = await thread.agent()
			const instructions = (agent.definition as { instructions?: unknown }).instructions
			if (typeof instructions === 'string') {
				const head = instructions.trimStart()
				for (const [heading, slug] of ROLE_HEADINGS) {
					if (head.startsWith(heading)) {
						role = slug
						break
					}
				}
				if (role === null) {
					// Backstop for a profile whose sentinel heading was lost.
					const trimmed = instructions.trim()
					if (trimmed === LEAD_PROMPT) role = 'lead'
					else if (trimmed === PEER_PROMPT) role = 'peer'
					else if (trimmed === SUPERVISOR_PROMPT) role = 'supervisor'
				}
			}
		} catch {
			// Best effort: an unknown thread is simply not orchestrated.
		}
		roleCache.set(thread.id, role)
		return role
	}

	/**
	 * Who a thread owes one report to when it next settles, keyed by that thread.
	 *
	 * A thread reports once, to whoever last addressed it. The plugin registers
	 * this when it hands a new agent its brief, and when an agent messages a
	 * known agent thread directly. The settle consumes it, so later turns stay
	 * silent until someone addresses the thread again.
	 */
	const pendingReply = new Map<string, string>()

	/** Turns already reported, so a redelivered `agent.end` cannot report twice. */
	const reportedTurns = new Set<string>()

	/** Record that `child` owes `to` one report when it next settles. */
	function expectReply(child: string, to: string): void {
		if (!child || !to || child === to) return
		pendingReply.set(child, to)
	}

	/**
	 * Report a settled turn to the thread that last addressed this one, inlining
	 * the agent's closing output so the recipient does not have to read the child
	 * thread first.
	 */
	async function reportSettle(event: AgentEndEvent): Promise<void> {
		const target = pendingReply.get(event.thread.id)
		if (!target) return
		pendingReply.delete(event.thread.id)

		const turnKey = `${event.thread.id}:${event.id}`
		if (reportedTurns.has(turnKey)) return
		reportedTurns.add(turnKey)
		if (reportedTurns.size > 500) reportedTurns.clear()

		const record = registry.get(event.thread.id)
		if (!record) return

		const url = new URL(`/threads/${event.thread.id}`, amp.system.ampURL).href
		await amp.threads.get(target as ThreadID).appendUserMessage({
			type: 'user-message',
			content: settledNotice(record, event.status, closingText(event.messages), url),
		})
	}

	/**
	 * Agent-to-agent messages register a one-shot reply. Only an agent's own tool
	 * call counts here: a human typing into a thread is not a tool call, so it
	 * never puts a thread on a reporting loop.
	 */
	const MESSAGING_TOOLS = new Set(['send_thread_message', 'agent_send'])
	amp.on('tool.call', (event) => {
		if (MESSAGING_TOOLS.has(event.tool)) {
			const target = str(event.input, 'thread') || str(event.input, 'threadId')
			if (target && registry.get(target)) expectReply(target, event.thread.id)
		}
		return { action: 'allow' as const }
	})

	amp.on('session.start', async (_event, ctx) => {
		registry.touch(ctx.thread.id, 'running')
	})

	amp.on('agent.end', async (event, ctx) => {
		const role = await roleOf(ctx.thread)

		// Keep agent_inbox's last report current, from the agent's closing words.
		if (registry.get(event.thread.id)) {
			registry.recordReport(
				event.thread.id,
				closingText(event.messages) || '(no text output this turn)',
				event.status === 'done' ? 'idle' : event.status,
			)
		}

		if (role !== 'lead' && role !== 'peer') return

		// A — report the settled turn to whoever last addressed this thread.
		await reportSettle(event)
	})

	// ── Agent instructions are the only guidance source ──────────────────────
	// The mode system prompts come from profiles/*.md via createAgent() above.
	// No skills are registered: the Lead/Peer/Supervisor behavior lives entirely
	// in the agent instructions.
}
