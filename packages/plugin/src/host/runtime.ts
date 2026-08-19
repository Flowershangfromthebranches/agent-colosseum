import { PINNED_DSH_VERSION, defaultStakeSpec, uuidv7, type GrantV1 } from '@agent-colosseum/protocol'
import { generateDeviceKeypair, signStake, toHex, randomBytes } from '@agent-colosseum/crypto'
import { ArenaAgentRunner, type AgentsLike } from './agent-runner.ts'
import { ArenaConnection } from './connection.ts'
import { streamGrantThroughOwner, type GrantLedger, type GrantPeer, type OwnerLlm } from './grant-relay.ts'
import type { GenerateOptions, StreamChunk } from './llm-adapter.ts'
import { runLocalMatch } from './local-match.ts'
import { SnapshotStore } from './snapshot-store.ts'
import { assertCompatible } from './compat.ts'

export interface PluginConfig {
  serverUrl: string
  inviteCode: string
  allowUnverifiedDsh: boolean
}

export class ArenaRuntime {
  readonly store = new SnapshotStore()
  readonly runner: ArenaAgentRunner
  connection: ArenaConnection | null = null
  private localAbort: AbortController | null = null
  readonly grantListeners = new Set<() => void>()
  ownerLlm: OwnerLlm | null = null
  ownerPeer: GrantPeer | null = null
  ledger: GrantLedger | null = null

  constructor(
    agents: AgentsLike,
    readonly config: PluginConfig,
    private readonly listLocalModels: () => Promise<Array<{ provider: string; model: string; name: string; allowedForStake: boolean }>>,
    private readonly credentials?: { resolve(ref: string): Promise<{ value: string } | undefined>; set(ref: string, value: string): Promise<void> },
  ) {
    this.runner = new ArenaAgentRunner(agents)
  }

  async start(): Promise<void> {
    const version = assertCompatible(this.config.allowUnverifiedDsh)
    this.store.patch({ dshVersion: version, compatible: true })
    this.connection = new ArenaConnection(this.config.serverUrl, this.config.inviteCode, this.store, this.credentials)
    if (this.config.serverUrl) await this.connection.start()
  }

  async bootstrap() {
    if (!this.store.snapshot.dshVersion) await this.start()
    const models = (await this.listLocalModels()).filter((item) => item.provider !== 'script')
    return this.store.patch({ models })
  }

  ackPrivacy() {
    return this.store.patch({ privacyAcknowledged: true, view: 'lobby' })
  }

  async startLocal(left: { provider: string; model: string }, right: { provider: string; model: string }) {
    this.localAbort?.abort()
    this.localAbort = new AbortController()
    const deviceA = this.store.snapshot.deviceId && this.store.snapshot.deviceId.includes('-')
      ? this.store.snapshot.deviceId
      : uuidv7()
    await runLocalMatch({
      store: this.store,
      runner: this.runner,
      deviceA,
      left,
      right,
      signal: this.localAbort.signal,
    })
    return this.store.snapshot
  }

  async cancelLocal() {
    this.localAbort?.abort()
    await this.runner.dispose()
    return this.store.patch({ view: 'lobby', match: undefined, result: undefined })
  }

  async createRoom(provider: string, model: string) {
    const keys = this.connection?.keys ?? generateDeviceKeypair()
    const deviceId = this.store.snapshot.deviceId ?? 'pending'
    const unsigned = defaultStakeSpec(deviceId, provider, model, toHex(randomBytes(16)), 'pending')
    const stake = { ...unsigned, signature: signStake(keys.ed25519PrivateKey, unsigned) }
    this.connection?.send('room.create', { stake })
    await this.runner.createContestant({ key: 'online', provider, model })
    this.connection?.bindContestant(this.runner, 'online')
    return this.store.patch({ view: 'room' })
  }

  async joinRoom(roomCode: string, provider: string, model: string) {
    const keys = this.connection?.keys ?? generateDeviceKeypair()
    const deviceId = this.store.snapshot.deviceId ?? 'pending'
    const unsigned = defaultStakeSpec(deviceId, provider, model, toHex(randomBytes(16)), 'pending')
    const stake = { ...unsigned, signature: signStake(keys.ed25519PrivateKey, unsigned) }
    this.connection?.send('room.join', { roomCode, stake })
    await this.runner.createContestant({ key: 'online', provider, model })
    this.connection?.bindContestant(this.runner, 'online')
    return this.store.patch({ view: 'room', roomCode })
  }

  acceptRoom() {
    const roomId = this.store.snapshot.roomId
    if (!roomId) throw new Error('no room')
    const keys = this.connection?.keys ?? generateDeviceKeypair()
    const deviceId = this.store.snapshot.deviceId ?? 'pending'
    const model = this.store.snapshot.models[0]
    const unsigned = defaultStakeSpec(deviceId, model?.provider ?? 'openai-compatible', model?.model ?? 'local', toHex(randomBytes(16)), 'pending')
    const stake = { ...unsigned, signature: signStake(keys.ed25519PrivateKey, unsigned) }
    this.connection?.send('room.accept', { roomId, stake })
    return this.store.snapshot
  }

  leaveRoom() {
    if (this.store.snapshot.roomId) this.connection?.send('room.leave', { roomId: this.store.snapshot.roomId })
    return this.store.patch({ view: 'lobby', roomId: undefined, roomCode: undefined })
  }

  setGrants(grants: unknown[]) {
    this.store.patch({ grants })
    for (const listener of this.grantListeners) listener()
  }

  bindOwner(llm: OwnerLlm, peer: GrantPeer, ledger: GrantLedger): void {
    this.ownerLlm = llm
    this.ownerPeer = peer
    this.ledger = ledger
  }

  async * streamGrant(options: GenerateOptions, grant: GrantV1): AsyncIterable<StreamChunk> {
    this.store.patch({ view: 'relay', relay: { grantId: grant.grantId, status: 'reserve' } })
    if (!this.ownerLlm || !this.ownerPeer || !this.ledger) {
      if (this.connection) {
        yield* this.connection.streamAsWinner(options, grant)
        return
      }
      throw Object.assign(new Error('grant relay is disconnected'), { code: 'RELAY_DISCONNECTED' })
    }
    const winnerKeys = this.connection?.keys ?? generateDeviceKeypair()
    const winnerId = this.store.snapshot.deviceId ?? grant.winnerDeviceId
    try {
      yield* streamGrantThroughOwner({
        grant,
        options,
        winner: { deviceId: winnerId, keys: winnerKeys },
        owner: this.ownerPeer,
        ownerLlm: this.ownerLlm,
        ledger: this.ledger,
        ownerOnline: grant.ownerOnline,
      })
      this.store.patch({ relay: { grantId: grant.grantId, status: 'completed' } })
    } catch (error) {
      this.store.patch({
        relay: {
          grantId: grant.grantId,
          status: 'error',
          error: error instanceof Error ? error.message : 'relay failed',
        },
      })
      throw error
    }
  }

  async dispose() {
    this.localAbort?.abort()
    this.connection?.stop()
    await this.runner.dispose()
  }
}

export { PINNED_DSH_VERSION }
