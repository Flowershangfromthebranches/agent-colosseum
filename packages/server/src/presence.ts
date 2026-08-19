import { DISCONNECT_FORFEIT_MS, HEARTBEAT_TIMEOUT_MS } from '@agent-colosseum/protocol'

export interface PresenceBook {
  connect(deviceId: string, now?: number): void
  disconnect(deviceId: string): void
  beat(deviceId: string, now?: number): void
  isOnline(deviceId: string, now?: number): boolean
  offlineSince(deviceId: string, now?: number): number | null
  socketsOf(deviceId: string): number
}

export class MemoryPresence implements PresenceBook {
  private readonly entries = new Map<string, { lastBeat: number; sockets: number }>()

  connect(deviceId: string, now = Date.now()): void {
    const current = this.entries.get(deviceId) ?? { lastBeat: now, sockets: 0 }
    current.sockets += 1
    current.lastBeat = now
    this.entries.set(deviceId, current)
  }

  disconnect(deviceId: string): void {
    const current = this.entries.get(deviceId)
    if (!current) return
    current.sockets = Math.max(0, current.sockets - 1)
    if (current.sockets === 0) this.entries.delete(deviceId)
  }

  beat(deviceId: string, now = Date.now()): void {
    const current = this.entries.get(deviceId)
    if (current) current.lastBeat = now
  }

  isOnline(deviceId: string, now = Date.now()): boolean {
    const current = this.entries.get(deviceId)
    return Boolean(current && current.sockets > 0 && now - current.lastBeat <= HEARTBEAT_TIMEOUT_MS)
  }

  offlineSince(deviceId: string, now = Date.now()): number | null {
    if (this.isOnline(deviceId, now)) return null
    const current = this.entries.get(deviceId)
    return current ? now - current.lastBeat : DISCONNECT_FORFEIT_MS + 1
  }

  socketsOf(deviceId: string): number {
    return this.entries.get(deviceId)?.sockets ?? 0
  }
}
