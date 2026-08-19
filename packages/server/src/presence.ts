import { HEARTBEAT_TIMEOUT_MS } from '@agent-colosseum/protocol'

export interface PresenceBook {
  connect(deviceId: string, now?: number): void
  disconnect(deviceId: string, now?: number): void
  beat(deviceId: string, now?: number): void
  isOnline(deviceId: string, now?: number): boolean
  offlineSince(deviceId: string, now?: number): number | null
  socketsOf(deviceId: string): number
}

export class MemoryPresence implements PresenceBook {
  private readonly entries = new Map<string, { lastBeat: number; sockets: number; disconnectedAt: number | null }>()

  connect(deviceId: string, now = Date.now()): void {
    const current = this.entries.get(deviceId) ?? { lastBeat: now, sockets: 0, disconnectedAt: null }
    current.sockets += 1
    current.lastBeat = now
    current.disconnectedAt = null
    this.entries.set(deviceId, current)
  }

  disconnect(deviceId: string, now = Date.now()): void {
    const current = this.entries.get(deviceId) ?? { lastBeat: now, sockets: 0, disconnectedAt: now }
    current.sockets = Math.max(0, current.sockets - 1)
    if (current.sockets === 0 && current.disconnectedAt === null) current.disconnectedAt = now
    this.entries.set(deviceId, current)
  }

  beat(deviceId: string, now = Date.now()): void {
    const current = this.entries.get(deviceId)
    if (current) {
      current.lastBeat = now
      if (current.sockets > 0) current.disconnectedAt = null
    }
  }

  isOnline(deviceId: string, now = Date.now()): boolean {
    const current = this.entries.get(deviceId)
    return Boolean(current && current.sockets > 0 && now - current.lastBeat <= HEARTBEAT_TIMEOUT_MS)
  }

  offlineSince(deviceId: string, now = Date.now()): number | null {
    if (this.isOnline(deviceId, now)) return null
    const current = this.entries.get(deviceId)
    if (!current) return null
    if (current.disconnectedAt !== null) return Math.max(0, now - current.disconnectedAt)
    return Math.max(0, now - current.lastBeat)
  }

  socketsOf(deviceId: string): number {
    return this.entries.get(deviceId)?.sockets ?? 0
  }
}
