import type { AgentEndEvent, PluginAPI, ThreadMessage } from '@ampcode/plugin'

/** Marker in a nudge message so the watchdog never reacts to its own turn. */
export const NUDGE_MARKER = '[watch:nudge]'

/** Commands that count as verification of a change. */
const VERIFY_RE =
	/\b(test|tests|pytest|vitest|jest|tsc|typecheck|type-check|lint|eslint|ruff|biome|build|cargo|go\s+test|gradle|mvn|make|npm\s+run|pnpm|yarn)\b/i

/** Markers a report uses to hand back a blocked or reopened outcome. */
const HANDOFF_RE = /\b(BLOCKED|REOPEN_REQUEST|DEPENDENCY_REQUEST)\b/

/** Facts extracted from one agent turn. */
export interface TurnFacts {
	/** Text of the last assistant message in the turn. */
	report: string
	/** Shell commands run in the turn. */
	commands: string[]
	/** Failed tool results per tool name. */
	errorsByTool: Map<string, number>
	/** Number of files modified in the turn. */
	modifiedFiles: number
}

/** Read the mechanical facts of a turn from its messages. */
export function readTurn(
	messages: ThreadMessage[],
	helpers: Pick<
		PluginAPI['helpers'],
		'shellCommandFromToolCall' | 'filesModifiedByToolCall'
	>,
): TurnFacts {
	const toolUse = new Map<string, { tool: string; input: Record<string, unknown> }>()
	const errorsByTool = new Map<string, number>()
	const commands: string[] = []
	let report = ''
	let modifiedFiles = 0

	for (const message of messages) {
		if (message.role === 'assistant') {
			for (const block of message.content) {
				if (block.type !== 'tool_use') continue
				toolUse.set(block.id, { tool: block.name, input: block.input })
				const call = { toolUseID: block.id, tool: block.name, input: block.input }
				const command = helpers.shellCommandFromToolCall(call)
				if (command?.command) commands.push(command.command)
				const files = helpers.filesModifiedByToolCall(call)
				if (files) modifiedFiles += files.length
			}
			const text = message.content
				.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
				.map((block) => block.text)
				.join('\n')
				.trim()
			if (text) report = text
		} else if (message.role === 'user') {
			for (const block of message.content) {
				if (block.type !== 'tool_result' || block.status !== 'error') continue
				const tool = toolUse.get(block.toolUseID)?.tool ?? 'unknown'
				errorsByTool.set(tool, (errorsByTool.get(tool) ?? 0) + 1)
			}
		}
	}

	return { report, commands, errorsByTool, modifiedFiles }
}

/** What the watchdog decided to do about a turn. */
export interface Verdict {
	/** A mechanical correction to send back into the same thread. */
	nudge?: string
	/** A reason to wake the Supervisor with a digest. */
	wake?: string
}

/**
 * Judge one finished turn.
 *
 * Mechanical, unambiguous rule violations become a direct nudge (cheap, no
 * Supervisor turn). Judgement calls become a reason to wake the Supervisor.
 */
export function judge(event: AgentEndEvent, facts: TurnFacts): Verdict {
	// Never react to our own nudge turn.
	if (event.message.includes(NUDGE_MARKER)) return {}

	// Judgement calls → wake the Supervisor.
	if (event.status !== 'done') {
		return { wake: `turn ended as ${event.status}` }
	}
	const handoff = facts.report.match(HANDOFF_RE)?.[1]
	if (handoff) {
		return { wake: `report hands back a ${handoff}` }
	}

	// Mechanical rule violations → nudge the thread directly.
	if (facts.modifiedFiles > 0 && !facts.commands.some((command) => VERIFY_RE.test(command))) {
		return {
			nudge: `${NUDGE_MARKER} You changed ${facts.modifiedFiles} file(s) this turn but ran no verification command. Run the narrowest check that would catch a mistake in what you changed, then report the result.`,
		}
	}
	for (const [tool, count] of facts.errorsByTool) {
		if (count >= 3) {
			return {
				nudge: `${NUDGE_MARKER} The ${tool} tool failed ${count} times this turn. Diagnose the cause from the error output before repeating the same call.`,
			}
		}
	}

	return {}
}
