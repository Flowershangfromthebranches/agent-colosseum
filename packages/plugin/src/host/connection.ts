import {
  generateDeviceKeypair,
  randomBytes,
  signEntropy,
  signUtf8,
  toHex,
  type DeviceKeypair,
} from '@agent-colosseum/crypto'
import type { SeatId } from '@agent-colosseum/poker'
import type { ArenaAgentRunner } from './agent-runner.ts'
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  newMessageId,
  parseClientFrame,
  type KnownClientFrame,
} from '@agent-colosseum/protocol'
import {
  assertRequestLimits,
  newInferenceId,
  type GrantV1,
} from '@agent-colosseum/protocol'
import {
  measureGenerateOptions,
  requestHashOf,
  sealWinnerRequest,
  openWinnerRequest,
  ownerRoutedOptions,
} from './grant-relay.ts'
import type { GenerateOptions, StreamChunk } from './llm-adapter.ts'
import { deriveSharedKey, openJson, relayAad, sealJson } from '@agent-colosseum/crypto'
import type { SnapshotStore } from './snapshot-store.ts'

export class ArenaConnection {
  private ws: WebSocket | null = null
  private attempts = 0
  private closed = false
  keys: DeviceKeypair | null = null
  deviceId: string | null = null
  ownerLlm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> } | null = null
  runner: ArenaAgentRunner | null = null
  agentKey = 'online'
  private hole: [string, string] | null = null
  private seat: SeatId | null = null
  private matchId: string | null = null
  private readonly waiters = new Map<string, (payload: Record<string, unknown>) => void>()
  private readonly waiterRejects = new Set<(error: Error) => void>()
  private readonly backlog = new Map<string, Array<{ type: string; payload: Record<string, unknown> }>>()
  private readonly ownerAborts = new Map<string, AbortController>()
  private readonly winnerStops = new Set<AbortController>()
  private ready = false
  private readonly readyWaiters: Array<() => void> = []

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

  whenReady(timeoutMs = 15_000): Promise<void> {
    if (this.ready && this.ws?.readyState === 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('auth timeout')), timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private markReady(): void {
    this.ready = true
    for (const waiter of this.readyWaiters.splice(0)) waiter()
  }

  stop(): void {
    this.closed = true
    this.ws?.close()
  }

  bindContestant(runner: ArenaAgentRunner, key = 'online'): void {
    this.runner = runner
    this.agentKey = key
  }

  async * streamAsWinner(options: GenerateOptions, grant: GrantV1): AsyncIterable<StreamChunk> {
    if (!this.keys || !this.deviceId || this.ws?.readyState !== 1) {
      throw Object.assign(new Error('arena socket is not ready'), { code: 'RELAY_DISCONNECTED' })
    }
    const ownerPub = (grant as GrantV1 & { ownerX25519PublicKey?: string }).ownerX25519PublicKey
    if (!ownerPub) throw new Error('missing owner public key')
    const inferenceId = newInferenceId()
    const estimate = measureGenerateOptions(options)
    assertRequestLimits(estimate, options.maxTokens)
    const { box } = sealWinnerRequest({
      winnerPrivate: this.keys.x25519PrivateKey,
      ownerPublic: ownerPub,
      grantId: grant.grantId,
      inferenceId,
      options,
    })
    this.send('relay.reserve', {
      grantId: grant.grantId,
      inferenceId,
      ciphertext: box.ciphertext,
      nonce: box.nonce,
      estimatedInputTokens: estimate.estimatedInputTokens,
      requestBytes: estimate.bytes,
      requestHash: requestHashOf(options),
    })
    const stop = new AbortController()
    this.winnerStops.add(stop)
    const cancel = () => {
      if (!stop.signal.aborted) stop.abort()
      try {
        this.send('relay.terminal', { grantId: grant.grantId, inferenceId, status: 'cancelled' })
      } catch { /* socket may already be closed; server handleDisconnect still aborts the Owner */ }
      this.failWaiters(new Error('aborted'))
    }
    if (options.signal?.aborted) {
      cancel()
      this.winnerStops.delete(stop)
      return
    }
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      await this.waitType('relay.inference_started')
      const shared = deriveSharedKey(this.keys.x25519PrivateKey, ownerPub)
      while (!options.signal?.aborted && !stop.signal.aborted) {
        const frame = await this.waitType('relay.chunk', 'relay.terminal')
        if (frame.type === 'relay.terminal') return
        const seq = Number(frame.payload.seq)
        yield openJson<StreamChunk>(shared, {
          nonce: String(frame.payload.nonce),
          ciphertext: String(frame.payload.ciphertext),
        }, relayAad({ grantId: grant.grantId, inferenceId, seq, direction: 'owner_to_winner' }))
      }
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes('aborted')) throw error
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      this.winnerStops.delete(stop)
    }
  }

  private async submitEntropy(matchId: string): Promise<void> {
    if (!this.keys) return
    this.matchId = matchId
    const entropyHex = toHex(randomBytes(32))
    this.send('match.entropy', {
      matchId,
      entropyHex,
      signature: signEntropy(this.keys.ed25519PrivateKey, matchId, entropyHex),
    })
  }

  private ingestSnapshot(payload: Record<string, unknown>): void {
    this.store.patch({ view: 'table', match: payload })
    const matchId = payload.matchId
    if (typeof matchId === 'string') this.matchId = matchId
    const holes = payload.holes as Partial<Record<SeatId, [string, string]>> | undefined
    if (holes?.A && !holes.B) {
      this.seat = 'A'
      this.hole = holes.A
    } else if (holes?.B && !holes.A) {
      this.seat = 'B'
      this.hole = holes.B
    }
  }

  private async playAction(payload: Record<string, unknown>): Promise<void> {
    if (!this.runner || !this.seat || !this.hole || !this.matchId) return
    const legal = (payload.legal ?? []) as Array<{ action: 'fold' | 'check' | 'call' | 'raise'; minRaiseTo?: number; maxRaiseTo?: number }>
    const snapshot = {
      matchId: this.matchId,
      handNo: Number(payload.handNo ?? 1),
      actionSeq: Number(payload.actionSeq ?? 0),
      street: 'preflop' as const,
      button: 'A' as const,
      seats: { A: { deviceId: '', stack: 0, streetCommitted: 0 }, B: { deviceId: '', stack: 0, streetCommitted: 0 } },
      pot: 0,
      currentBet: 0,
      toAct: this.seat,
      board: [],
      holes: { [this.seat]: this.hole },
      blinds: { small: 1, big: 2 },
      lastActions: [],
      terminal: null,
      ...this.store.snapshot.match,
      legal,
    }
    try {
      const decided = await this.runner.decide({
        key: this.agentKey,
        snapshot,
        seat: this.seat,
        hole: this.hole,
      })
      this.send('match.action', {
        matchId: this.matchId,
        handNo: Number(payload.handNo),
        actionSeq: Number(payload.actionSeq),
        action: decided.decision.action,
        publicRationale: decided.decision.publicRationale,
        ...decided.decision.raiseTo === undefined ? {} : { raiseTo: decided.decision.raiseTo },
      })
    } catch {
      this.send('match.action', {
        matchId: this.matchId,
        handNo: Number(payload.handNo),
        actionSeq: Number(payload.actionSeq),
        action: 'fold',
        publicRationale: 'agent_fault: fold',
      })
    }
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

  private async persistIdentity(): Promise<void> {
    if (!this.keys) return
    await this.credentials?.set('AGENT_COLOSSEUM_DEVICE_KEYS', JSON.stringify({
      ...this.keys,
      ...this.deviceId ? { deviceId: this.deviceId } : {},
    }))
  }

  private async loadKeys(): Promise<void> {
    const existing = await this.credentials?.resolve('AGENT_COLOSSEUM_DEVICE_KEYS')
    if (existing?.value) {
      const parsed = JSON.parse(existing.value) as DeviceKeypair & { deviceId?: string }
      this.keys = parsed
      if (typeof parsed.deviceId === 'string' && parsed.deviceId.includes('-')) this.deviceId = parsed.deviceId
      return
    }
    this.keys = generateDeviceKeypair()
    await this.persistIdentity()
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
        this.markReady()
        void this.persistIdentity()
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
      if (data.type === 'match.proposal') {
        void this.submitEntropy(String(data.payload.matchId))
        return
      }
      if (data.type === 'match.private' || data.type === 'match.public') {
        this.ingestSnapshot(data.payload)
        return
      }
      if (data.type === 'match.action_request') {
        void this.playAction(data.payload)
        return
      }
      if (data.type === 'match.settled') {
        const terminal = data.payload.terminal as { winnerDeviceId?: string; reason?: string }
        this.store.patch({
          view: 'result',
          result: {
            ...terminal.winnerDeviceId ? { winner: terminal.winnerDeviceId } : {},
            ...terminal.reason ? { reason: terminal.reason } : {},
          },
        })
        return
      }
      if (data.type === 'grant.updated') {
        this.store.patch({
          ...this.store.snapshot.view === 'relay' ? {} : { view: 'grants' },
          grants: upsertGrant(this.store.snapshot.grants, data.payload),
          ownerOnline: Boolean((data.payload as { ownerOnline?: boolean }).ownerOnline),
        })
      }
      if (data.type === 'relay.reserve') {
        void this.fulfillAsOwner(data.payload)
      }
      if (data.type === 'relay.abort') {
        this.ownerAborts.get(`${data.payload.grantId}:${data.payload.inferenceId}`)?.abort()
        this.failWaiters(new Error('aborted'))
      }
      const waiter = this.waiters.get(data.type)
      if (waiter) {
        this.waiters.delete(data.type)
        waiter(data.payload)
      } else if (data.type === 'relay.chunk' || data.type === 'relay.terminal' || data.type === 'relay.inference_started') {
        const queued = this.backlog.get(data.type) ?? []
        queued.push({ type: data.type, payload: data.payload })
        this.backlog.set(data.type, queued)
      }
    })
    ws.addEventListener('close', () => {
      this.ready = false
      this.store.patch({ connectionState: 'offline', serverReachable: false })
      for (const stop of this.winnerStops) stop.abort()
      this.failWaiters(new Error('aborted'))
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

  private failWaiters(error: Error): void {
    const rejects = [...this.waiterRejects]
    this.waiterRejects.clear()
    this.waiters.clear()
    for (const reject of rejects) reject(error)
  }

  private waitType(...types: string[]): Promise<{ type: string; payload: Record<string, unknown> }> {
    for (const type of types) {
      const queued = this.backlog.get(type)
      const next = queued?.shift()
      if (next) return Promise.resolve(next)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiterRejects.delete(reject)
        reject(new Error('relay timeout'))
      }, 60_000)
      const fail = (error: Error) => {
        clearTimeout(timer)
        for (const type of types) this.waiters.delete(type)
        reject(error)
      }
      this.waiterRejects.add(fail)
      for (const type of types) {
        this.waiters.set(type, (payload) => {
          clearTimeout(timer)
          this.waiterRejects.delete(fail)
          for (const other of types) this.waiters.delete(other)
          resolve({ type, payload })
        })
      }
    })
  }

  private async fulfillAsOwner(payload: Record<string, unknown>): Promise<void> {
    if (!this.ownerLlm || !this.keys) return
    const grantId = String(payload.grantId)
    const inferenceId = String(payload.inferenceId)
    const winnerPub = String(payload.winnerX25519PublicKey ?? '')
    const abort = new AbortController()
    this.ownerAborts.set(`${grantId}:${inferenceId}`, abort)
    try {
      const opened = openWinnerRequest({
        ownerPrivate: this.keys.x25519PrivateKey,
        winnerPublic: winnerPub,
        grantId,
        inferenceId,
        box: { nonce: String(payload.nonce), ciphertext: String(payload.ciphertext) },
      })
      this.send('relay.preflight_ok', { grantId, inferenceId, requestHash: requestHashOf(opened) })
      await this.waitType('relay.inference_started')
      const grant = (this.store.snapshot.grants as GrantV1[]).find((item) => item.grantId === grantId)
      if (!grant) throw new Error('GRANT_UNAVAILABLE')
      const routed = ownerRoutedOptions(grant, opened, abort.signal)
      const shared = deriveSharedKey(this.keys.x25519PrivateKey, winnerPub)
      let seq = 1
      if (abort.signal.aborted) throw new Error('aborted')
      for await (const chunk of this.ownerLlm.stream(routed)) {
        if (abort.signal.aborted) break
        const sealed = sealJson(shared, chunk, relayAad({
          grantId, inferenceId, seq, direction: 'owner_to_winner',
        }))
        this.send('relay.chunk', { grantId, inferenceId, seq, ciphertext: sealed.ciphertext, nonce: sealed.nonce })
        seq += 1
      }
      this.send('relay.terminal', { grantId, inferenceId, status: abort.signal.aborted ? 'aborted' : 'completed' })
    } catch {
      this.send('relay.terminal', {
        grantId,
        inferenceId,
        status: abort.signal.aborted ? 'aborted' : 'provider_error',
      })
    } finally {
      this.ownerAborts.delete(`${grantId}:${inferenceId}`)
    }
  }
}

function upsertGrant(grants: unknown[], grant: unknown): unknown[] {
  const id = (grant as { grantId?: string }).grantId
  const next = Array.isArray(grants) ? [...grants] : []
  const index = next.findIndex((item) => (item as { grantId?: string }).grantId === id)
  if (index >= 0) next[index] = grant
  else next.push(grant)
  return next
}
