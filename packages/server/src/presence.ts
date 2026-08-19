import { DISCONNECT_FORFEIT_MS, HEARTBEAT_TIMEOUT_MS } from '@agent-colosseum/protocol'

export interface PresenceEntry {
  deviceId: string
  lastBeat: number
  sockets: number
}

export class PresenceBook {
  private readonly entries = new Map<string, PresenceEntry>()

  connect(deviceId: string, now = Date.now()): void {
    const current = this.entries.get(deviceId) ?? { deviceId, lastBeat: now, sockets: 0 }
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
    if (!current || current.sockets <= 0) return false
    return now - current.lastBeat <= HEARTBEAT_TIMEOUT_MS
  }

  offlineSince(deviceId: string, now = Date.now()): number | null {
    const current = this.entries.get(deviceId)
    if (current && current.sockets > 0 && now - current.lastBeat <= HEARTBEAT_TIMEOUT_MS) return null
    const last = current?.lastBeat ?? 0
    return last === 0 ? DISCONNECT_FORFEIT_MS + 1 : now - last
  }
}
