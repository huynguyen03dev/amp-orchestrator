// @amp-agent-mode {"key":"lead-gpt","label":"Lead - GPT Luna","color":"#d97706"}
// @amp-agent-mode {"key":"lead-deepseek","label":"Lead - DeepSeek","color":"#d97706"}
// @amp-agent-mode {"key":"lead-glm","label":"Lead - GLM 5.3","color":"#d97706"}
// @amp-agent-mode {"key":"lead-glm-flash","label":"Lead - GLM Flash","color":"#d97706"}
// @amp-agent-mode {"key":"peer-gpt","label":"Peer - GPT Luna","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-deepseek","label":"Peer - DeepSeek","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-glm","label":"Peer - GLM 5.3","color":"#2563eb"}
// @amp-agent-mode {"key":"peer-glm-flash","label":"Peer - GLM Flash","color":"#2563eb"}
// @amp-agent-mode {"key":"supervisor-gpt","label":"Supervisor - GPT Luna","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-deepseek","label":"Supervisor - DeepSeek","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-glm","label":"Supervisor - GLM 5.3","color":"#64748b"}
// @amp-agent-mode {"key":"supervisor-glm-flash","label":"Supervisor - GLM Flash","color":"#64748b"}
import { readFileSync } from 'node:fs'
import type {
	Agent,
	AgentReasoningEffort,
	AgentToolSelection,
	PluginAPI,
	ThreadAssistantMessage,
	ThreadID,
} from '@ampcode/plugin'
import { PeerRegistry } from './lib/registry'

/**
 * Directory name of this plugin. Plugin tools are addressable as
 * `plugin__<pluginName>__<toolName>`, so the directory must keep this name for
 * the Lead/Peer tool selections below to resolve.
 */
const PLUGIN_NAME = 'amp-orchestrator'
const ORCHESTRATOR_TOOLS = `plugin__${PLUGIN_NAME}__*`

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
	label: string
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

const ROLES: RoleSpec[] = [
	{
		slug: 'lead',
		label: 'Lead',
		color: '#d97706',
		extends: 'high',
		effort: 'max',
		instructions: LEAD_PROMPT,
		tools: { add: [ORCHESTRATOR_TOOLS] },
		description: (m) =>
			`Orchestrates Peers on ${m.short}: routes bounded outcomes, verifies, and accepts. Use to run a project.`,
	},
	{
		slug: 'peer',
		label: 'Peer',
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
		color: '#64748b',
		extends: 'medium',
		effort: 'high',
		instructions: SUPERVISOR_PROMPT,
		tools: {
			exclude: [
				ORCHESTRATOR_TOOLS,
				'edit_file',
				'create_file',
				'delete_file',
				'apply_patch',
			],
		},
		description: (m) => `Advisory delivery-quality observer on ${m.short}. Does not own project work.`,
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
	const registry = new PeerRegistry(
		workspaceRoot ? amp.helpers.filePathFromURI(workspaceRoot) : null,
	)

	// ── Modes: every model × every role ──────────────────────────────────────
	// One peer agent handle per model, used by `peer_spawn`.
	const peerAgents = new Map<string, Agent>()

	for (const model of MODELS) {
		for (const role of ROLES) {
			const key = `${role.slug}-${model.slug}`
			const label = `${role.label} - ${model.short}`
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
			if (role.slug === 'peer') peerAgents.set(model.slug, agent)
		}
	}

	const modelSlugs = MODELS.map((m) => m.slug)

	// ── Orchestration tools ──────────────────────────────────────────────────

	amp.registerTool({
		name: 'peer_spawn',
		title: 'Spawn peer',
		transcriptGroup: { active: 'Spawning peer', complete: 'Spawned peer' },
		description:
			'Create a new Peer thread that owns one bounded outcome, send it the brief, and return its thread ID.',
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
		async execute(input, ctx) {
			const name = str(input, 'name')
			const disposition = str(input, 'disposition') || 'Engineer'
			const brief = str(input, 'brief')
			const modelSlug = str(input, 'model') || modelSlugs[0]
			if (!name) throw new Error('peer_spawn requires a non-empty name')
			if (!brief) throw new Error('peer_spawn requires a non-empty brief')
			const peer = peerAgents.get(modelSlug)
			if (!peer) {
				throw new Error(`Unknown peer model "${modelSlug}". Known: ${modelSlugs.join(', ')}`)
			}

			const thread = await peer.createThread({ parentThreadID: ctx.thread.id })
			await thread.appendUserMessage({
				type: 'user-message',
				content: `[peer ${name} · ${disposition} · ${modelSlug}]\n\n${brief}`,
			})

			registry.upsert({
				id: thread.id,
				name,
				disposition,
				brief,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				lastStatus: 'running',
			})

			const url = new URL(`/threads/${thread.id}`, amp.system.ampURL).href
			return `Spawned peer "${name}" (${disposition} · ${modelSlug}) → ${thread.id}\n${url}`
		},
	})

	amp.registerTool({
		name: 'peer_send',
		title: 'Send to peer',
		transcriptGroup: { active: 'Messaging peer', complete: 'Messaged peer' },
		description: 'Append a follow-up message to an existing Peer thread.',
		inputSchema: {
			type: 'object',
			properties: {
				threadId: { type: 'string', description: 'Peer thread ID, e.g. T-...' },
				message: { type: 'string', description: 'Message to append.' },
			},
			required: ['threadId', 'message'],
		},
		async execute(input) {
			const threadId = str(input, 'threadId')
			const message = str(input, 'message')
			if (!threadId || !message) throw new Error('peer_send requires threadId and message')
			await amp.threads.get(threadId as ThreadID).appendUserMessage({
				type: 'user-message',
				content: message,
			})
			registry.touch(threadId, 'running')
			return `Sent to ${threadId}`
		},
	})

	amp.registerTool({
		name: 'peer_wait',
		title: 'Wait for peer',
		transcriptGroup: { active: 'Waiting for peer', complete: 'Peer replied' },
		description:
			'Block once until a Peer finishes its current turn and return its reply. Rejects on error or timeout.',
		inputSchema: {
			type: 'object',
			properties: {
				threadId: { type: 'string', description: 'Peer thread ID, e.g. T-...' },
				timeoutMs: { type: 'number', description: 'Timeout in ms. Defaults to 10 minutes.' },
			},
			required: ['threadId'],
		},
		async execute(input) {
			const threadId = str(input, 'threadId')
			if (!threadId) throw new Error('peer_wait requires threadId')
			const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined
			const reply = await amp.threads
				.get(threadId as ThreadID)
				.waitForResponse(timeoutMs ? { timeoutMs } : undefined)
			const text = textOf(reply)
			registry.recordReport(threadId, text, 'idle')
			return text || '(peer returned no text)'
		},
	})

	amp.registerTool({
		name: 'peer_status',
		title: 'Peer status',
		description: "Read a Peer thread's activity state and its most recent messages.",
		inputSchema: {
			type: 'object',
			properties: {
				threadId: { type: 'string', description: 'Peer thread ID, e.g. T-...' },
			},
			required: ['threadId'],
		},
		async execute(input) {
			const threadId = str(input, 'threadId')
			if (!threadId) throw new Error('peer_status requires threadId')
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
		name: 'peer_inbox',
		title: 'Peer inbox',
		transcriptGroup: { active: 'Reading inbox', complete: 'Read inbox' },
		description:
			'List every Peer this Lead has spawned, with disposition, status, and the latest report.',
		inputSchema: { type: 'object', properties: {} },
		async execute() {
			const peers = registry.list()
			if (peers.length === 0) return 'No peers yet.'
			return peers
				.map((p) => {
					const age = Math.round((Date.now() - p.updatedAt) / 1000)
					const report = p.lastReport ? `\n  last report: ${p.lastReport.slice(0, 600)}` : ''
					return `- ${p.name} (${p.disposition}) [${p.lastStatus}] ${p.id} · ${age}s ago${report}`
				})
				.join('\n')
		},
	})

	// ── Agent instructions are the only guidance source ──────────────────────
	// The mode system prompts come from profiles/*.md via createAgent() above.
	// No skills are registered: the Lead/Peer/Supervisor behavior lives entirely
	// in the agent instructions.
}
