import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One agent thread a Lead or Supervisor has spawned. */
export interface AgentRecord {
	id: string
	role: string
	name: string
	disposition: string
	model: string
	brief: string
	/** Thread that spawned this agent, so a monitor can walk back to the Lead. */
	spawnedBy: string
	createdAt: number
	updatedAt: number
	lastStatus: string
	lastReport?: string
}

interface RegistryFile {
	version: 1
	agents: Record<string, AgentRecord>
}

/**
 * A best-effort index of the agents a Lead or Supervisor has spawned for one
 * workspace.
 *
 * The registry is a convenience view for `agent_inbox`; the Amp threads it
 * points at are the real source of truth. It is persisted to the user's cache so
 * it survives a plugin reload or a runner restart.
 */
export class AgentRegistry {
	private readonly path: string
	private agents: Record<string, AgentRecord> = {}

	constructor(workspaceRootPath: string | null) {
		const key = createHash('sha256')
			.update(workspaceRootPath ?? 'no-workspace')
			.digest('hex')
			.slice(0, 16)
		this.path = join(homedir(), '.cache', 'amp', 'orchestrator', `${key}.json`)
		this.load()
	}

	private load(): void {
		try {
			const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<RegistryFile>
			if (parsed && typeof parsed === 'object' && parsed.agents) this.agents = parsed.agents
		} catch {
			this.agents = {}
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true })
			const file: RegistryFile = { version: 1, agents: this.agents }
			writeFileSync(this.path, JSON.stringify(file, null, 2))
		} catch {
			// Best effort only: the registry is an index, not a source of truth.
		}
	}

	upsert(record: AgentRecord): void {
		this.agents[record.id] = record
		this.save()
	}

	touch(id: string, status: string): void {
		const agent = this.agents[id]
		if (!agent) return
		agent.lastStatus = status
		agent.updatedAt = Date.now()
		this.save()
	}

	recordReport(id: string, report: string, status = 'idle'): void {
		const agent = this.agents[id]
		if (!agent) return
		agent.lastReport = report
		agent.lastStatus = status
		agent.updatedAt = Date.now()
		this.save()
	}

	list(): AgentRecord[] {
		return Object.values(this.agents).sort((a, b) => b.updatedAt - a.updatedAt)
	}

	get(id: string): AgentRecord | undefined {
		return this.agents[id]
	}
}
