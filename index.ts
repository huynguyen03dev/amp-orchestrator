// @amp-agent-mode {"key":"lead-gpt","label":"SLP - Lead GPT Luna","color":"#d97706"}
// @amp-agent-mode {"key":"lead-deepseek","label":"SLP - Lead DeepSeek","color":"#d97706"}
// @amp-agent-mode {"key":"lead-glm","label":"SLP - Lead GLM 5.3","color":"#d97706"}
// @amp-agent-mode {"key":"lead-glm-flash","label":"SLP - Lead GLM Flash","color":"#d97706"}
// @amp-agent-mode {"key":"peer-gpt","label":"SLP - Peer GPT Luna","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-deepseek","label":"SLP - Peer DeepSeek","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-glm","label":"SLP - Peer GLM 5.3","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-glm-flash","label":"SLP - Peer GLM Flash","color":"#2563eb"}
// @amp-agent-mode {"key":"supervisor-gpt","label":"SLP - Sup GPT Luna","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-deepseek","label":"SLP - Sup DeepSeek","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-glm","label":"SLP - Sup GLM 5.3","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-glm-flash","label":"SLP - Sup GLM Flash","color":"#64748b"}
import { readFileSync } from 'node:fs'
import type {
	Agent,
	AgentReasoningEffort,
	AgentToolSelection,
	PluginAPI,
	PluginThread,
	PluginToolContext,
	ThreadAssistantMessage,
	ThreadID,
} from '@ampcode/plugin'
import { AgentRegistry } from './lib/registry'
import { judge, readTurn } from './lib/watchdog'

/**
 * Directory name of this plugin. Plugin tools are addressable as
 * `plugin__<pluginName>__<toolName>`, so the directory must keep this name for
 * the tool selections below to resolve.
 */
const PLUGIN_NAME = 'amp-orchestrator'
const ORCHESTRATOR_TOOLS = `plugin__${PLUGIN_NAME}__*`
/** Visible prefix on every orchestration mode, so they filter together. */
const MODE_PREFIX = 'SLP - '
const tool = (name: string): string => `plugin__${PLUGIN_NAME}__${name}`

/** Read/inspect tools both the Lead and the Supervisor get. */
const GENERIC_AGENT_TOOLS = [
	tool('agent_send'),
	tool('agent_wait'),
	tool('agent_status'),
	tool('agent_inbox'),
]

const readProfile = (name: string): string =>
	readFileSync(new URL(`./profiles/${name}.md`, import.meta.url), 'utf8').trim()

const LEAD_PROMPT = readProfile('lead')
const PEER_PROMPT = readProfile('peer')
const SUPERVISOR_PROMPT = readProfile('supervisor')

/** A model every role can be pinned to. Models must be served by a user connection. */
interface ModelSpec {
	slug: string
	model: string
	short: string
}

/** A role every model can be pinned to. */
interface RoleSpec {
	slug: string
	/** Full role name, used in descriptions. */
	label: string
	/** Compact role name used in the mode label. */
	short: string
	color: string
	extends: 'high' | 'medium'
	effort: AgentReasoningEffort
	instructions: string
	tools: AgentToolSelection
	description: (model: ModelSpec) => string
}

const MODELS: ModelSpec[] = [
	{ slug: 'gpt', model: 'openai/gpt-5.6-luna', short: 'GPT Luna' },
	{ slug: 'deepseek', model: 'deepseek/deepseek-v4.1-flash', short: 'DeepSeek' },
	{ slug: 'glm', model: 'zhipuai/glm-5.3', short: 'GLM 5.3' },
	{ slug: 'glm-flash', model: 'zhipuai/glm-5.3-flash', short: 'GLM Flash' },
]

/**
 * Tool selection per role.
 *
 * - Lead: `peer_spawn` (peers only) plus the generic agent tools. It cannot
 *   create a Lead, so a project has exactly one Lead at a time.
 * - Supervisor: `lead_spawn` (successor Lead for recovery) plus the generic agent
 *   tools. It cannot create a Peer.
 * - Peer: no orchestrator tools at all, so it can never recursively spawn.
 */
const ROLES: RoleSpec[] = [
	{
		slug: 'lead',
		label: 'Lead',
		short: 'Lead',
		color: '#d97706',
		extends: 'high',
		effort: 'max',
		instructions: LEAD_PROMPT,
		tools: {
			add: [tool('peer_spawn'), ...GENERIC_AGENT_TOOLS],
			exclude: [tool('lead_spawn')],
		},
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
		tools: { exclude: [ORCHESTRATOR_TOOLS] },
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
			add: [tool('lead_spawn'), ...GENERIC_AGENT_TOOLS],
			exclude: [
				tool('peer_spawn'),
				'edit_file',
				'create_file',
				'delete_file',
				'apply_patch',
			],
		},
		description: (m) =>
			`Advisory observer on ${m.short}. Can create a successor Lead for recovery; does not own project work.`,
	},
]

function textOf(message: ThreadAssistantMessage): string {
	return message.content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
		.trim()
}

function str(input: Record<string, unknown>, key: string): string {
	const value = input[key]
	return typeof value === 'string' ? value.trim() : ''
}

export default function (amp: PluginAPI) {
	const workspaceRoot = amp.system.workspaceRoot
	const registry = new AgentRegistry(
		workspaceRoot ? amp.helpers.filePathFromURI(workspaceRoot) : null,
	)

	// ── Modes: every model × every role ──────────────────────────────────────
	// One agent handle per `<role>-<model>`, used by the spawn tools.
	const agents = new Map<string, Agent>()

	for (const model of MODELS) {
		for (const role of ROLES) {
			const key = `${role.slug}-${model.slug}`
			const label = `${MODE_PREFIX}${role.short} ${model.short}`
			const agent = amp.createAgent({
				extends: role.extends,
				model: model.model,
				instructions: role.instructions,
				tools: role.tools,
				reasoningEffort: role.effort,
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
		}
	}

	const modelSlugs = MODELS.map((m) => m.slug)

	/** Shared spawn: create a thread for `<role>-<model>` and send it the brief. */
	async function spawn(
		roleSlug: 'lead' | 'peer',
		input: Record<string, unknown>,
		ctx: PluginToolContext,
	): Promise<string> {
		const modelSlug = str(input, 'model') || modelSlugs[0]
		const name = str(input, 'name')
		const brief = str(input, 'brief')
		const disposition = str(input, 'disposition') || (roleSlug === 'lead' ? 'Lead' : 'Engineer')
		if (!name) throw new Error(`${roleSlug}_spawn requires a non-empty name`)
		if (!brief) throw new Error(`${roleSlug}_spawn requires a non-empty brief`)

		const agent = agents.get(`${roleSlug}-${modelSlug}`)
		if (!agent) {
			throw new Error(
				`Unknown model "${modelSlug}". Models: ${modelSlugs.join(', ')}.`,
			)
		}

		const thread = await agent.createThread({ parentThreadID: ctx.thread.id })
		const header =
			roleSlug === 'lead'
				? `[lead ${name} · ${modelSlug}]`
				: `[peer ${name} · ${disposition} · ${modelSlug}]`
		await thread.appendUserMessage({
			type: 'user-message',
			content: `${header}\n\n${brief}`,
		})

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
			'Create a new Peer thread that owns one bounded outcome, send it the brief, and return its thread ID. Each Peer runs in its own Amp thread.',
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
					enum: modelSlugs,
					description: `Model for the peer. One of: ${modelSlugs.join(', ')}. Defaults to "${modelSlugs[0]}".`,
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
					enum: modelSlugs,
					description: `Model for the new Lead. One of: ${modelSlugs.join(', ')}. Defaults to "${modelSlugs[0]}".`,
				},
			},
			required: ['name', 'brief'],
		},
		execute: (input, ctx) => spawn('lead', input, ctx),
	})

	// ── Generic agent tools (Lead and Supervisor) ────────────────────────────

	amp.registerTool({
		name: 'agent_send',
		title: 'Send to agent',
		transcriptGroup: { active: 'Messaging agent', complete: 'Messaged agent' },
		description: 'Append a follow-up message to an agent thread you spawned.',
		inputSchema: {
			type: 'object',
			properties: {
				threadId: { type: 'string', description: 'Agent thread ID, e.g. T-...' },
				message: { type: 'string', description: 'Message to append.' },
			},
			required: ['threadId', 'message'],
		},
		async execute(input) {
			const threadId = str(input, 'threadId')
			const message = str(input, 'message')
			if (!threadId || !message) throw new Error('agent_send requires threadId and message')
			await amp.threads.get(threadId as ThreadID).appendUserMessage({
				type: 'user-message',
				content: message,
			})
			registry.touch(threadId, 'running')
			return `Sent to ${threadId}`
		},
	})

	amp.registerTool({
		name: 'agent_wait',
		title: 'Wait for agent',
		transcriptGroup: { active: 'Waiting for agent', complete: 'Agent replied' },
		description:
			'Block once until an agent finishes its current turn and return its reply. Rejects on error or timeout.',
		inputSchema: {
			type: 'object',
			properties: {
				threadId: { type: 'string', description: 'Agent thread ID, e.g. T-...' },
				timeoutMs: { type: 'number', description: 'Timeout in ms. Defaults to 10 minutes.' },
			},
			required: ['threadId'],
		},
		async execute(input) {
			const threadId = str(input, 'threadId')
			if (!threadId) throw new Error('agent_wait requires threadId')
			const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined
			const reply = await amp.threads
				.get(threadId as ThreadID)
				.waitForResponse(timeoutMs ? { timeoutMs } : undefined)
			const text = textOf(reply)
			registry.recordReport(threadId, text, 'idle')
			return text || '(agent returned no text)'
		},
	})

	amp.registerTool({
		name: 'agent_status',
		title: 'Agent status',
		description: "Read an agent thread's activity state and its most recent messages.",
		inputSchema: {
			type: 'object',
			properties: {
				threadId: { type: 'string', description: 'Agent thread ID, e.g. T-...' },
			},
			required: ['threadId'],
		},
		async execute(input) {
			const threadId = str(input, 'threadId')
			if (!threadId) throw new Error('agent_status requires threadId')
			const thread = amp.threads.get(threadId as ThreadID)
			const state = await thread.state.get()
			const messages = await thread.messages({ from: 'end', limit: 4 })
			const recent = messages.map((message) => {
				if (message.role === 'assistant') return `assistant: ${textOf(message).slice(0, 800)}`
				if (message.role === 'user') return 'user: (brief or follow-up)'
				return 'info'
			})
			return JSON.stringify({ threadId, state, recent }, null, 2)
		},
	})

	amp.registerTool({
		name: 'agent_inbox',
		title: 'Agent inbox',
		transcriptGroup: { active: 'Reading inbox', complete: 'Read inbox' },
		description:
			'List every agent this thread spawned, with role, model, disposition, status, spawning thread, and the latest report.',
		inputSchema: { type: 'object', properties: {} },
		async execute() {
			const records = registry.list()
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

	// ── Watchdog: nudge threads, wake the Supervisor (B + C) ─────────────────
	// The plugin sees agent.end for every thread this runner hosts, so it can
	// course-correct a Lead or Peer without a separate monitoring loop.
	//   C — a mechanical rule violation returns `continue` and nudges the thread.
	//   B — a judgement call appends a digest to the Supervisor thread to wake it.
	const roleCache = new Map<string, string | null>()
	const supervisorThreads = new Set<string>()
	const lastWake = new Map<string, number>()
	const lastNudge = new Map<string, number>()
	const WAKE_COOLDOWN_MS = 10 * 60 * 1000
	const NUDGE_COOLDOWN_MS = 90 * 1000

	async function roleOf(thread: PluginThread): Promise<string | null> {
		const cached = roleCache.get(thread.id)
		if (cached !== undefined) return cached
		let role: string | null = null
		try {
			const agent = await thread.agent()
			const instructions = (agent.definition as { instructions?: unknown }).instructions
			if (typeof instructions === 'string') {
				const trimmed = instructions.trim()
				if (trimmed === LEAD_PROMPT) role = 'lead'
				else if (trimmed === PEER_PROMPT) role = 'peer'
				else if (trimmed === SUPERVISOR_PROMPT) role = 'supervisor'
			}
		} catch {
			// Best effort: an unknown thread is simply not orchestrated.
		}
		roleCache.set(thread.id, role)
		return role
	}

	amp.on('session.start', async (_event, ctx) => {
		if ((await roleOf(ctx.thread)) === 'supervisor') supervisorThreads.add(ctx.thread.id)
	})

	amp.on('agent.end', async (event, ctx) => {
		const role = await roleOf(ctx.thread)
		if (role === 'supervisor') {
			supervisorThreads.add(ctx.thread.id)
			return
		}
		if (role !== 'lead' && role !== 'peer') return

		const facts = readTurn(event.messages, amp.helpers)
		const verdict = judge(event, facts)

		// C — nudge the thread itself.
		if (verdict.nudge) {
			const now = Date.now()
			if (now - (lastNudge.get(event.thread.id) ?? 0) < NUDGE_COOLDOWN_MS) return
			lastNudge.set(event.thread.id, now)
			return { action: 'continue' as const, userMessage: verdict.nudge }
		}

		// B — wake the Supervisor.
		if (!verdict.wake) return
		const now = Date.now()
		if (now - (lastWake.get(event.thread.id) ?? 0) < WAKE_COOLDOWN_MS) return
		const supervisor = [...supervisorThreads][0]
		if (!supervisor) return
		lastWake.set(event.thread.id, now)

		const url = new URL(`/threads/${event.thread.id}`, amp.system.ampURL).href
		await amp.threads.get(supervisor as ThreadID).appendUserMessage({
			type: 'user-message',
			content: `[watch] ${role} ${event.thread.id} — ${verdict.wake}\n${url}`,
		})
	})

	// ── Agent instructions are the only guidance source ──────────────────────
	// The mode system prompts come from profiles/*.md via createAgent() above.
	// No skills are registered: the Lead/Peer/Supervisor behavior lives entirely
	// in the agent instructions.
}
