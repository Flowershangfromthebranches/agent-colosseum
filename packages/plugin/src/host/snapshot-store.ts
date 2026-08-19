export type ArenaView = 'privacy' | 'lobby' | 'room' | 'table' | 'result' | 'grants' | 'relay'

export interface ArenaSnapshot {
  view: ArenaView
  privacyAcknowledged: boolean
  deviceId: string | null
  dshVersion: string
  compatible: boolean
  serverReachable: boolean
  connectionState: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'offline'
  ownerOnline: boolean
  roomCode?: string
  roomId?: string
  models: Array<{ provider: string; model: string; name: string; allowedForStake: boolean }>
  match?: Record<string, unknown>
  result?: { winner?: string; reason?: string }
  grants: unknown[]
  relay?: { grantId?: string; status?: string; error?: string }
  disclosure: string
  error?: string
  lastActions: unknown[]
}

export const DISCLOSURE = 'The model owner can theoretically inspect relayed prompt text. Never send unauthorized secrets through a grant model.'

export function emptySnapshot(): ArenaSnapshot {
  return {
    view: 'privacy',
    privacyAcknowledged: false,
    deviceId: null,
    dshVersion: '0.1.0-rc.7',
    compatible: true,
    serverReachable: false,
    connectionState: 'idle',
    ownerOnline: false,
    models: [],
    grants: [],
    disclosure: DISCLOSURE,
    lastActions: [],
  }
}

export class SnapshotStore {
  private value = emptySnapshot()
  private cursor = 0
  private readonly listeners = new Set<(snapshot: ArenaSnapshot, cursor: number) => void>()
  private readonly waiters: Array<() => void> = []

  get snapshot(): ArenaSnapshot { return this.value }
  get version(): number { return this.cursor }

  patch(partial: Record<string, unknown>): ArenaSnapshot {
    const next: Record<string, unknown> = { ...this.value }
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) delete next[key]
      else next[key] = value
    }
    this.value = next as unknown as ArenaSnapshot
    this.cursor += 1
    for (const listener of this.listeners) listener(this.value, this.cursor)
    for (const wait of this.waiters.splice(0)) wait()
    return this.value
  }

  subscribe(listener: (snapshot: ArenaSnapshot, cursor: number) => void): () => void {
    this.listeners.add(listener)
    listener(this.value, this.cursor)
    return () => this.listeners.delete(listener)
  }

  wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
