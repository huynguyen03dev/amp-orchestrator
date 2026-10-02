import { readFileSync } from 'node:fs'
import type { PluginAPI, ThreadAssistantMessage, ThreadID } from '@ampcode/plugin'
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

export default async function (amp: PluginAPI) {
	const workspaceRoot = amp.system.workspaceRoot
	const registry = new PeerRegistry(
		workspaceRoot ? amp.helpers.filePathFromURI(workspaceRoot) : null,
	)

	// ── Agent modes ──────────────────────────────────────────────────────────

	const lead = amp.createAgent({
		name: 'lead',
		extends: 'high',
		instructions: LEAD_PROMPT,
		tools: { add: [ORCHESTRATOR_TOOLS] },
		display: { label: 'Lead', color: '#d97706' },
	})
	amp.registerAgentMode({
		key: 'lead',
		label: 'Lead',
		description:
			'Orchestrates Peers: routes bounded outcomes, verifies, and accepts. Use to run a project.',
		color: '#d97706',
		agent: lead.definition,
	})

	const peer = amp.createAgent({
		name: 'peer',
		extends: 'medium',
		instructions: PEER_PROMPT,
		tools: { exclude: [ORCHESTRATOR_TOOLS] },
		display: { label: 'Peer', color: '#2563eb' },
	})
	amp.registerAgentMode({
		key: 'peer',
		label: 'Peer',
		description:
			'Independent collaborator that owns one bounded outcome. Normally created by a Lead.',
		color: '#2563eb',
		agent: peer.definition,
	})

	const supervisor = amp.createAgent({
		name: 'supervisor',
		extends: 'medium',
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
		display: { label: 'Supervisor', color: '#64748b' },
	})
	amp.registerAgentMode({
		key: 'supervisor',
		label: 'Supervisor',
		description: 'Advisory observer of delivery quality. Does not own project work.',
		color: '#64748b',
		agent: supervisor.definition,
	})

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
			},
			required: ['name', 'disposition', 'brief'],
		},
		async execute(input, ctx) {
			const name = str(input, 'name')
			const disposition = str(input, 'disposition') || 'Engineer'
			const brief = str(input, 'brief')
			if (!name) throw new Error('peer_spawn requires a non-empty name')
			if (!brief) throw new Error('peer_spawn requires a non-empty brief')

			const thread = await peer.createThread({ parentThreadID: ctx.thread.id })
			await thread.appendUserMessage({
				type: 'user-message',
				content: `[peer ${name} · ${disposition}]\n\n${brief}`,
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
			return `Spawned peer "${name}" (${disposition}) → ${thread.id}\n${url}`
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

	// ── Skills ───────────────────────────────────────────────────────────────

	await amp.registerSkill({ path: 'skills/lead' })
	await amp.registerSkill({ path: 'skills/peer' })
	await amp.registerSkill({ path: 'skills/supervisor' })
}
