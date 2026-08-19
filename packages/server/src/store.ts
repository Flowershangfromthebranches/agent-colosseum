import type { GrantV1, InferenceCallV1, PokerMatchStateV1, StakeSpecV1 } from '@agent-colosseum/protocol'

export type DeviceRecord = {
  deviceId: string
  ed25519PublicKey: string
  x25519PublicKey: string
  createdAt: number
  lastSeenAt: number
}

export type InviteRecord = { codeHash: string; usesRemaining: number; maxUses: number }

export type RoomRecord = {
  roomId: string
  roomCode: string
  hostDeviceId: string
  guestDeviceId: string | null
  hostStake: StakeSpecV1
  guestStake: StakeSpecV1 | null
  hostAccepted: boolean
  guestAccepted: boolean
  matchId: string | null
  status: 'open' | 'matched' | 'closed'
}

export type MatchRecord = {
  matchId: string
  roomId: string
  deviceA: string
  deviceB: string
  commitment: string
  serverSeedHex: string
  entropyA: string | null
  entropyB: string | null
  status: 'pending_entropy' | 'live' | 'terminal'
  winnerDeviceId: string | null
  settled: boolean
  state: PokerMatchStateV1 | null
  createdAt: number
}

export type StakeRecord = {
  stakeId: string
  matchId: string
  spec: StakeSpecV1
  status: 'locked' | 'unlocked' | 'converted' | 'released'
}

export type GrantRecord = GrantV1 & {
  stakeId: string
  lastOnlineTickAt: number | null
}

export interface ArenaStore {
  consumeInvite(codeHash: string): Promise<boolean>
  seedInvite(codeHash: string, uses: number): Promise<void>
  putDevice(device: DeviceRecord): Promise<void>
  getDevice(deviceId: string): Promise<DeviceRecord | undefined>
  findDeviceByEd25519(key: string): Promise<DeviceRecord | undefined>
  findDeviceByX25519(key: string): Promise<DeviceRecord | undefined>
  touchDevice(deviceId: string, at: number): Promise<void>
  putRoom(room: RoomRecord): Promise<void>
  getRoom(roomId: string): Promise<RoomRecord | undefined>
  findRoomByCode(code: string): Promise<RoomRecord | undefined>
  updateRoom(roomId: string, patch: Partial<RoomRecord>): Promise<RoomRecord>
  putMatch(match: MatchRecord): Promise<void>
  getMatch(matchId: string): Promise<MatchRecord | undefined>
  listLiveMatches(): Promise<MatchRecord[]>
  saveMatchState(matchId: string, patch: Partial<MatchRecord>): Promise<void>
  settleInTransaction(input: {
    matchId: string
    winnerDeviceId: string | null
    reason: string
    grant?: GrantRecord
    stakeUpdates: Array<{ stakeId: string; status: StakeRecord['status'] }>
  }): Promise<{ first: boolean; grant: GrantRecord | null }>
  putStake(stake: StakeRecord): Promise<void>
  listStakes(matchId: string): Promise<StakeRecord[]>
  getGrant(grantId: string): Promise<GrantRecord | undefined>
  listGrantsForWinner(deviceId: string): Promise<GrantRecord[]>
  listGrantsForOwner(deviceId: string): Promise<GrantRecord[]>
  saveGrant(grant: GrantRecord): Promise<void>
  getInference(grantId: string, inferenceId: string): Promise<InferenceCallV1 | undefined>
  listOpenInferencesForRequester(deviceId: string): Promise<InferenceCallV1[]>
  insertInference(record: InferenceCallV1): Promise<'created' | 'duplicate'>
  updateInference(record: InferenceCallV1): Promise<void>
  deductIfStarted(grantId: string, inferenceId: string): Promise<GrantRecord>
  appendEvent(matchId: string, seq: number, hash: string, payload: unknown): Promise<void>
  listEvents(matchId: string): Promise<Array<{ seq: number; hash: string; payload: unknown }>>
  ping(): Promise<boolean>
}

export class MemoryStore implements ArenaStore {
  invites = new Map<string, InviteRecord>()
  devices = new Map<string, DeviceRecord>()
  rooms = new Map<string, RoomRecord>()
  roomsByCode = new Map<string, string>()
  matches = new Map<string, MatchRecord>()
  stakes = new Map<string, StakeRecord>()
  grants = new Map<string, GrantRecord>()
  inferences = new Map<string, InferenceCallV1>()
  events = new Map<string, Array<{ seq: number; hash: string; payload: unknown }>>()
  private readonly locks = new Map<string, Promise<void>>()

  async consumeInvite(codeHash: string): Promise<boolean> {
    const invite = this.invites.get(codeHash)
    if (!invite || invite.usesRemaining <= 0) return false
    invite.usesRemaining -= 1
    return true
  }
  async seedInvite(codeHash: string, uses: number): Promise<void> {
    this.invites.set(codeHash, { codeHash, usesRemaining: uses, maxUses: uses })
  }
  async putDevice(device: DeviceRecord): Promise<void> {
    if ([...this.devices.values()].some((item) =>
      item.deviceId !== device.deviceId
      && (item.ed25519PublicKey === device.ed25519PublicKey || item.x25519PublicKey === device.x25519PublicKey))) {
      throw new Error('IDENTITY_CONFLICT')
    }
    if (this.devices.has(device.deviceId)) throw new Error('IDENTITY_CONFLICT')
    this.devices.set(device.deviceId, { ...device })
  }
  async getDevice(deviceId: string) { return this.devices.get(deviceId) }
  async findDeviceByEd25519(key: string) {
    return [...this.devices.values()].find((item) => item.ed25519PublicKey === key)
  }
  async findDeviceByX25519(key: string) {
    return [...this.devices.values()].find((item) => item.x25519PublicKey === key)
  }
  async touchDevice(deviceId: string, at: number) {
    const device = this.devices.get(deviceId)
    if (device) device.lastSeenAt = at
  }
  async putRoom(room: RoomRecord) {
    this.rooms.set(room.roomId, { ...room })
    this.roomsByCode.set(room.roomCode, room.roomId)
  }
  async getRoom(roomId: string) { return this.rooms.get(roomId) }
  async findRoomByCode(code: string) {
    const id = this.roomsByCode.get(code)
    return id ? this.rooms.get(id) : undefined
  }
  async updateRoom(roomId: string, patch: Partial<RoomRecord>) {
    const room = this.rooms.get(roomId)
    if (!room) throw new Error('room not found')
    Object.assign(room, patch)
    return room
  }
  async putMatch(match: MatchRecord) { this.matches.set(match.matchId, { ...match }) }
  async getMatch(matchId: string) { return this.matches.get(matchId) }
  async listLiveMatches() {
    return [...this.matches.values()].filter((item) => item.status === 'live' || item.status === 'pending_entropy')
  }
  async saveMatchState(matchId: string, patch: Partial<MatchRecord>) {
    return this.withLock(matchId, async () => {
      const match = this.matches.get(matchId)
      if (!match) throw new Error('match not found')
      Object.assign(match, patch)
    })
  }
  async settleInTransaction(input: {
    matchId: string
    winnerDeviceId: string | null
    reason: string
    grant?: GrantRecord
    stakeUpdates: Array<{ stakeId: string; status: StakeRecord['status'] }>
  }) {
    return this.withLock(input.matchId, async () => {
      const match = this.matches.get(input.matchId)
      if (!match) throw new Error('match not found')
      if (match.settled) {
        const existing = [...this.grants.values()].find((item) => item.stakeId && input.stakeUpdates.some((u) => u.stakeId === item.stakeId))
        return { first: false, grant: existing ?? null }
      }
      match.settled = true
      match.status = 'terminal'
      match.winnerDeviceId = input.winnerDeviceId
      for (const update of input.stakeUpdates) {
        const stake = this.stakes.get(update.stakeId)
        if (!stake) throw new Error('stake not found')
        stake.status = update.status
      }
      if (input.grant) this.grants.set(input.grant.grantId, { ...input.grant })
      return { first: true, grant: input.grant ?? null }
    })
  }
  async putStake(stake: StakeRecord) { this.stakes.set(stake.stakeId, { ...stake }) }
  async listStakes(matchId: string) {
    return [...this.stakes.values()].filter((item) => item.matchId === matchId)
  }
  async getGrant(grantId: string) { return this.grants.get(grantId) }
  async listGrantsForWinner(deviceId: string) {
    return [...this.grants.values()].filter((item) => item.winnerDeviceId === deviceId)
  }
  async listGrantsForOwner(deviceId: string) {
    return [...this.grants.values()].filter((item) => item.ownerDeviceId === deviceId)
  }
  async saveGrant(grant: GrantRecord) { this.grants.set(grant.grantId, { ...grant }) }
  async getInference(grantId: string, inferenceId: string) {
    return this.inferences.get(`${grantId}:${inferenceId}`)
  }
  async listOpenInferencesForRequester(deviceId: string) {
    return [...this.inferences.values()].filter((item) =>
      item.requesterDeviceId === deviceId && item.finishedAt === null)
  }
  async insertInference(record: InferenceCallV1) {
    const key = `${record.grantId}:${record.inferenceId}`
    if (this.inferences.has(key)) return 'duplicate'
    this.inferences.set(key, { ...record })
    return 'created'
  }
  async updateInference(record: InferenceCallV1) {
    this.inferences.set(`${record.grantId}:${record.inferenceId}`, { ...record })
  }
  async appendEvent(matchId: string, seq: number, hash: string, payload: unknown) {
    const list = this.events.get(matchId) ?? []
    if (list.some((item) => item.seq === seq)) throw new Error('duplicate event seq')
    list.push({ seq, hash, payload })
    this.events.set(matchId, list)
  }
  async listEvents(matchId: string) { return [...(this.events.get(matchId) ?? [])] }
  async ping() { return true }

  async deductIfStarted(grantId: string, inferenceId: string): Promise<GrantRecord> {
    return this.withLock(`grant:${grantId}`, async () => {
      const grant = this.grants.get(grantId)
      const inference = this.inferences.get(`${grantId}:${inferenceId}`)
      if (!grant || !inference) throw new Error('missing')
      if (inference.deducted) return grant
      if (grant.callsRemaining <= 0) throw new Error('GRANT_EXHAUSTED')
      if (grant.activeConcurrency >= 1) throw new Error('CONCURRENCY')
      grant.callsRemaining -= 1
      grant.activeConcurrency += 1
      grant.version += 1
      if (grant.callsRemaining === 0) {
        grant.status = 'exhausted'
        grant.statusReason = 'calls_exhausted'
      }
      inference.deducted = true
      inference.status = 'started'
      inference.startedAt = Date.now()
      return grant
    })
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(key, previous.then(() => current))
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
