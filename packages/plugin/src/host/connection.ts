import {
  generateDeviceKeypair,
  signUtf8,
  type DeviceKeypair,
} from '@agent-colosseum/crypto'
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  newMessageId,
  parseClientFrame,
  type KnownClientFrame,
} from '@agent-colosseum/protocol'
import type { SnapshotStore } from './snapshot-store.ts'

export class ArenaConnection {
  private ws: WebSocket | null = null
  private attempts = 0
  private closed = false
  keys: DeviceKeypair | null = null
  deviceId: string | null = null

  constructor(
    private readonly url: string,
    private readonly inviteCode: string,
    private readonly store: SnapshotStore,
    private readonly credentials?: { resolve(ref: string): Promise<{ value: string } | undefined>; set(ref: string, value: string): Promise<void> },
  ) {}

  async start(): Promise<void> {
    await this.loadKeys()
    this.connect()
  }

  stop(): void {
    this.closed = true
    this.ws?.close()
  }

  send(type: KnownClientFrame['type'], payload: unknown): void {
    const frame = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: newMessageId(),
      sentAt: Date.now(),
      type,
      payload,
    }
    parseClientFrame(frame)
    this.ws?.send(JSON.stringify(frame))
  }

  private async loadKeys(): Promise<void> {
    const existing = await this.credentials?.resolve('AGENT_COLOSSEUM_DEVICE_KEYS')
    if (existing?.value) {
      this.keys = JSON.parse(existing.value) as DeviceKeypair
      return
    }
    this.keys = generateDeviceKeypair()
    await this.credentials?.set('AGENT_COLOSSEUM_DEVICE_KEYS', JSON.stringify(this.keys))
  }

  private connect(): void {
    if (this.closed) return
    this.store.patch({ connectionState: this.attempts === 0 ? 'connecting' : 'reconnecting' })
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.addEventListener('open', () => {
      this.attempts = 0
      this.send('auth.hello', {
        ...this.inviteCode ? { inviteCode: this.inviteCode } : {},
        ed25519PublicKey: this.keys!.ed25519PublicKey,
        x25519PublicKey: this.keys!.x25519PublicKey,
      })
    })
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data)) as { type: string; payload: Record<string, unknown> }
      if (data.type === 'auth.challenge') {
        const nonce = String(data.payload.nonce)
        this.send('auth.challenge_response', {
          nonce,
          signature: signUtf8(this.keys!.ed25519PrivateKey, this.deviceId ? `agent-colosseum/device-v1\n${this.deviceId}\n${nonce}` : nonce),
          ...this.deviceId ? { deviceId: this.deviceId } : {},
        })
        return
      }
      if (data.type === 'auth.session') {
        this.deviceId = String(data.payload.deviceId)
        this.store.patch({ connectionState: 'ready', serverReachable: true, deviceId: this.deviceId })
        return
      }
      if (data.type === 'room.created' || data.type === 'room.updated') {
        this.store.patch({
          view: 'room',
          roomId: String(data.payload.roomId ?? ''),
          roomCode: String(data.payload.roomCode ?? ''),
        })
        return
      }
      if (data.type === 'match.private' || data.type === 'match.public') {
        this.store.patch({ view: 'table', match: data.payload })
        return
      }
      if (data.type === 'match.settled') {
        const terminal = data.payload.terminal as { winnerDeviceId?: string; reason?: string }
        this.store.patch({
          view: 'result',
          result: { ...terminal.winnerDeviceId ? { winner: terminal.winnerDeviceId } : {}, reason: terminal.reason },
        })
        return
      }
      if (data.type === 'grant.updated') {
        this.store.patch({ view: 'grants', grants: [data.payload] })
      }
    })
    ws.addEventListener('close', () => {
      this.store.patch({ connectionState: 'offline', serverReachable: false })
      if (this.closed) return
      const delay = Math.min(15_000, 500 * 2 ** this.attempts)
      this.attempts += 1
      setTimeout(() => this.connect(), delay)
    })
    const beat = setInterval(() => {
      if (ws.readyState === ws.OPEN) this.send('session.heartbeat', { at: Date.now() })
    }, HEARTBEAT_INTERVAL_MS)
    ws.addEventListener('close', () => clearInterval(beat))
  }
}
