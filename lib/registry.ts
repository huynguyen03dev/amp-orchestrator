import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One Peer this Lead has spawned. */
export interface PeerRecord {
	id: string
	name: string
	disposition: string
	brief: string
	createdAt: number
	updatedAt: number
	lastStatus: string
	lastReport?: string
}

interface RegistryFile {
	version: 1
	peers: Record<string, PeerRecord>
}

/**
 * A best-effort index of the peers a Lead has spawned for one workspace.
 *
 * The registry is a convenience view for `peer_inbox`; the Amp threads it points
 * at are the real source of truth. It is persisted to the user's cache so it
 * survives a plugin reload or a runner restart.
 */
export class PeerRegistry {
	private readonly path: string
	private peers: Record<string, PeerRecord> = {}

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
			if (parsed && typeof parsed === 'object' && parsed.peers) this.peers = parsed.peers
		} catch {
			this.peers = {}
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true })
			const file: RegistryFile = { version: 1, peers: this.peers }
			writeFileSync(this.path, JSON.stringify(file, null, 2))
		} catch {
			// Best effort only: the registry is an index, not a source of truth.
		}
	}

	upsert(record: PeerRecord): void {
		this.peers[record.id] = record
		this.save()
	}

	touch(id: string, status: string): void {
		const peer = this.peers[id]
		if (!peer) return
		peer.lastStatus = status
		peer.updatedAt = Date.now()
		this.save()
	}

	recordReport(id: string, report: string, status = 'idle'): void {
		const peer = this.peers[id]
		if (!peer) return
		peer.lastReport = report
		peer.lastStatus = status
		peer.updatedAt = Date.now()
		this.save()
	}

	list(): PeerRecord[] {
		return Object.values(this.peers).sort((a, b) => b.updatedAt - a.updatedAt)
	}

	get(id: string): PeerRecord | undefined {
		return this.peers[id]
	}
}
