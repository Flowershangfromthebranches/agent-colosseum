import {
  commitServerSeed,
  deriveHandDeck,
  generateDeviceKeypair,
  randomBytes,
  signUtf8,
  toHex,
  type DeviceKeypair,
} from '@agent-colosseum/crypto'
import { playScriptedMatch, PokerEngine, type PublicMatchSnapshot } from '@agent-colosseum/poker'
import {
  defaultStakeSpec,
  newDeviceId,
  PINNED_DSH_VERSION,
  PROVIDER_ID,
  type Grant,
} from '@agent-colosseum/protocol'
import { ArenaAgentRunner, type AgentsLike } from './agent-runner.ts'
import { assertCompatible } from './compat.ts'

export interface PluginConfig {
  serverUrl: string
  inviteCode: string
  allowUnverifiedDsh: boolean
}

export interface ArenaUiState {
  view: 'privacy' | 'lobby' | 'table' | 'result' | 'grants'
  privacyAcknowledged: boolean
  deviceId: string
  dshVersion: string
  serverReachable: boolean
  ownerOnline: boolean
  roomCode?: string
  roomId?: string
  match?: PublicMatchSnapshot
  result?: { winner?: string; reason?: string }
  grants: Grant[]
  localModels: Array<{ provider: string; model: string; name: string; allowedForStake: boolean }>
  relay?: { grantId?: string; status?: string }
  disclosure: string
}

const DISCLOSURE = 'The model owner can theoretically inspect relayed prompt text. Never send unauthorized secrets through a grant model.'

export class ArenaRuntime {
  deviceId = ''
  keys: DeviceKeypair | null = null
  privacyAcknowledged = false
  grants: Grant[] = []
  localEngine: PokerEngine | null = null
  cursor = 0
  models: ArenaUiState['localModels'] = []
  listeners = new Set<(state: ArenaUiState) => void>()
  readonly runner: ArenaAgentRunner
  private grantListeners = new Set<() => void>()

  constructor(
    private readonly agents: AgentsLike,
    readonly config: PluginConfig,
    private readonly listLocalModels: () => Promise<ArenaUiState['localModels']>,
    private readonly credentials?: {
      resolve(ref: string): Promise<{ value: string } | undefined>
      set(ref: string, value: string): Promise<void>
    },
  ) {
    this.runner = new ArenaAgentRunner({
      agents,
      waitForOutput: async (agent) => {
        await agent.whenIdle()
        return ''
      },
    })
  }

  onGrantsChanged(listener: () => void): () => void {
    this.grantListeners.add(listener)
    return () => this.grantListeners.delete(listener)
  }

  async start(): Promise<void> {
    assertCompatible(this.config.allowUnverifiedDsh)
    await this.loadOrCreateKeys()
  }

  async bootstrap(): Promise<ArenaUiState> {
    if (!this.deviceId) await this.start()
    this.models = await this.listLocalModels()
    return this.snapshot()
  }

  ackPrivacy(): ArenaUiState {
    this.privacyAcknowledged = true
    return this.snapshot()
  }

  async startLocal(input: {
    left: { provider: string; model: string }
    right: { provider: string; model: string }
  }): Promise<ArenaUiState> {
    const matchId = `local-${Date.now()}`
    const button = this.deviceId
    const bb = newDeviceId()
    if (input.left.provider === 'script' && input.right.provider === 'script') {
      const played = playScriptedMatch({
        matchId,
        buttonDeviceId: button,
        bbDeviceId: bb,
        buttonPolicy: 'check-fold',
        bbPolicy: 'call-station',
      })
      this.localEngine = played.engine
      return this.snapshot({
        view: 'result',
        result: {
          ...played.terminal.winnerDeviceId ? { winner: played.terminal.winnerDeviceId } : {},
          reason: played.terminal.reason,
        },
        match: played.engine.snapshot(),
      })
    }
    const engine = new PokerEngine({
      matchId,
      buttonDeviceId: button,
      bbDeviceId: bb,
    })
    const seed = commitServerSeed()
    const entropy: [string, string] = [toHex(randomBytes(32)), toHex(randomBytes(32))]
    await this.runner.createContestant({ key: 'left', ...input.left })
    await this.runner.createContestant({ key: 'right', ...input.right })
    const deck = deriveHandDeck({
      matchId,
      handNo: 1,
      serverSeedHex: seed.serverSeedHex,
      playerEntropy: entropy,
    })
    engine.startHand(deck)
    this.localEngine = engine
    return this.snapshot({ view: 'table', match: engine.snapshot() })
  }

  setGrants(grants: Grant[]): void {
    this.grants = grants
    for (const listener of this.grantListeners) listener()
  }

  snapshot(overrides: Partial<ArenaUiState> = {}): ArenaUiState {
    const match = overrides.match ?? this.localEngine?.snapshot()
    return {
      view: overrides.view ?? (this.privacyAcknowledged ? 'lobby' : 'privacy'),
      privacyAcknowledged: this.privacyAcknowledged,
      deviceId: this.deviceId,
      dshVersion: PINNED_DSH_VERSION,
      serverReachable: overrides.serverReachable ?? false,
      ownerOnline: overrides.ownerOnline ?? true,
      grants: overrides.grants ?? this.grants,
      localModels: overrides.localModels ?? this.models,
      disclosure: DISCLOSURE,
      ...overrides.privacyAcknowledged === undefined ? {} : { privacyAcknowledged: overrides.privacyAcknowledged },
      ...match === undefined ? {} : { match },
      ...overrides.roomCode === undefined ? {} : { roomCode: overrides.roomCode },
      ...overrides.roomId === undefined ? {} : { roomId: overrides.roomId },
      ...overrides.result === undefined ? {} : { result: overrides.result },
      ...overrides.relay === undefined ? {} : { relay: overrides.relay },
    }
  }

  private async loadOrCreateKeys(): Promise<void> {
    const ref = 'AGENT_COLOSSEUM_DEVICE_KEYS'
    const existing = await this.credentials?.resolve(ref)
    if (existing?.value) {
      this.keys = JSON.parse(existing.value) as DeviceKeypair
      this.deviceId = this.keys.deviceId
      return
    }
    this.deviceId = newDeviceId()
    this.keys = generateDeviceKeypair(this.deviceId)
    await this.credentials?.set(ref, JSON.stringify(this.keys))
  }

  signStake(provider: string, model: string) {
    const unsigned = defaultStakeSpec(this.deviceId, provider, model, 'pending')
    const signature = this.keys ? signUtf8(this.keys.ed25519PrivateKey, JSON.stringify({ ...unsigned, signature: undefined })) : 'local'
    return { ...unsigned, signature }
  }
}

export { PROVIDER_ID }
