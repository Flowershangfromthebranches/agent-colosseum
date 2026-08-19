import type { Grant, StakeSpec } from '@agent-colosseum/protocol'

export type DeviceRecord = {
  deviceId: string
  ed25519PublicKey: string
  x25519PublicKey: string
  createdAt: number
  lastSeenAt: number
}

export type RoomRecord = {
  roomId: string
  roomCode: string
  hostDeviceId: string
  guestDeviceId: string | null
  hostStake: StakeSpec
  guestStake: StakeSpec | null
  hostAccepted: boolean
  guestAccepted: boolean
  matchId: string | null
  status: 'open' | 'matched' | 'closed'
}

export type StakeRecord = {
  stakeId: string
  matchId: string
  spec: StakeSpec
  status: 'locked' | 'unlocked' | 'converted' | 'released'
}

export type GrantRecord = Grant & {
  stakeId: string
  lastOnlineTickAt: number | null
}

export type InferenceRecord = {
  grantId: string
  inferenceId: string
  status: 'reserved' | 'started' | 'completed' | 'cancelled' | 'provider_error' | 'aborted'
  deducted: boolean
  createdAt: number
}

export type MatchRecord = {
  matchId: string
  roomId: string
  buttonDeviceId: string
  bbDeviceId: string
  serverSeedHex: string
  commitment: string
  playerEntropy: [string, string]
  status: 'live' | 'terminal'
  winnerDeviceId: string | null
  settled: boolean
  createdAt: number
}

export type EventRecord = {
  matchId: string
  seq: number
  hash: string
  payload: unknown
}

export interface ArenaStore {
  putDevice(device: DeviceRecord): Promise<void>
  getDevice(deviceId: string): Promise<DeviceRecord | undefined>
  findDeviceByPubkey(ed25519PublicKey: string): Promise<DeviceRecord | undefined>
  touchDevice(deviceId: string, at: number): Promise<void>

  putRoom(room: RoomRecord): Promise<void>
  getRoom(roomId: string): Promise<RoomRecord | undefined>
  findRoomByCode(code: string): Promise<RoomRecord | undefined>
  updateRoom(roomId: string, patch: Partial<RoomRecord>): Promise<RoomRecord>

  putMatch(match: MatchRecord): Promise<void>
  getMatch(matchId: string): Promise<MatchRecord | undefined>
  settleMatch(matchId: string, winnerDeviceId: string | null): Promise<boolean>

  putStake(stake: StakeRecord): Promise<void>
  listStakes(matchId: string): Promise<StakeRecord[]>
  updateStake(stakeId: string, status: StakeRecord['status']): Promise<void>

  putGrant(grant: GrantRecord): Promise<void>
  getGrant(grantId: string): Promise<GrantRecord | undefined>
  listGrantsForWinner(deviceId: string): Promise<GrantRecord[]>
  saveGrant(grant: GrantRecord): Promise<void>

  reserveInference(record: InferenceRecord): Promise<'created' | 'duplicate'>
  getInference(grantId: string, inferenceId: string): Promise<InferenceRecord | undefined>
  updateInference(grantId: string, inferenceId: string, patch: Partial<InferenceRecord>): Promise<InferenceRecord>

  appendEvent(event: EventRecord): Promise<void>
  listEvents(matchId: string): Promise<EventRecord[]>
}

export class MemoryStore implements ArenaStore {
  devices = new Map<string, DeviceRecord>()
  rooms = new Map<string, RoomRecord>()
  roomsByCode = new Map<string, string>()
  matches = new Map<string, MatchRecord>()
  stakes = new Map<string, StakeRecord>()
  grants = new Map<string, GrantRecord>()
  inferences = new Map<string, InferenceRecord>()
  events = new Map<string, EventRecord[]>()

  async putDevice(device: DeviceRecord): Promise<void> {
    this.devices.set(device.deviceId, device)
  }
  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.devices.get(deviceId)
  }
  async findDeviceByPubkey(ed25519PublicKey: string): Promise<DeviceRecord | undefined> {
    return [...this.devices.values()].find((device) => device.ed25519PublicKey === ed25519PublicKey)
  }
  async touchDevice(deviceId: string, at: number): Promise<void> {
    const device = this.devices.get(deviceId)
    if (device) device.lastSeenAt = at
  }
  async putRoom(room: RoomRecord): Promise<void> {
    this.rooms.set(room.roomId, { ...room })
    this.roomsByCode.set(room.roomCode, room.roomId)
  }
  async getRoom(roomId: string): Promise<RoomRecord | undefined> {
    return this.rooms.get(roomId)
  }
  async findRoomByCode(code: string): Promise<RoomRecord | undefined> {
    const id = this.roomsByCode.get(code)
    return id ? this.rooms.get(id) : undefined
  }
  async updateRoom(roomId: string, patch: Partial<RoomRecord>): Promise<RoomRecord> {
    const room = this.rooms.get(roomId)
    if (!room) throw new Error('room not found')
    Object.assign(room, patch)
    return room
  }
  async putMatch(match: MatchRecord): Promise<void> {
    this.matches.set(match.matchId, { ...match })
  }
  async getMatch(matchId: string): Promise<MatchRecord | undefined> {
    return this.matches.get(matchId)
  }
  async settleMatch(matchId: string, winnerDeviceId: string | null): Promise<boolean> {
    const match = this.matches.get(matchId)
    if (!match) throw new Error('match not found')
    if (match.settled) return false
    match.settled = true
    match.status = 'terminal'
    match.winnerDeviceId = winnerDeviceId
    return true
  }
  async putStake(stake: StakeRecord): Promise<void> {
    this.stakes.set(stake.stakeId, { ...stake })
  }
  async listStakes(matchId: string): Promise<StakeRecord[]> {
    return [...this.stakes.values()].filter((stake) => stake.matchId === matchId)
  }
  async updateStake(stakeId: string, status: StakeRecord['status']): Promise<void> {
    const stake = this.stakes.get(stakeId)
    if (!stake) throw new Error('stake not found')
    stake.status = status
  }
  async putGrant(grant: GrantRecord): Promise<void> {
    this.grants.set(grant.grantId, { ...grant })
  }
  async getGrant(grantId: string): Promise<GrantRecord | undefined> {
    return this.grants.get(grantId)
  }
  async listGrantsForWinner(deviceId: string): Promise<GrantRecord[]> {
    return [...this.grants.values()].filter((grant) => grant.winnerDeviceId === deviceId)
  }
  async saveGrant(grant: GrantRecord): Promise<void> {
    this.grants.set(grant.grantId, { ...grant })
  }
  async reserveInference(record: InferenceRecord): Promise<'created' | 'duplicate'> {
    const key = `${record.grantId}:${record.inferenceId}`
    if (this.inferences.has(key)) return 'duplicate'
    this.inferences.set(key, { ...record })
    return 'created'
  }
  async getInference(grantId: string, inferenceId: string): Promise<InferenceRecord | undefined> {
    return this.inferences.get(`${grantId}:${inferenceId}`)
  }
  async updateInference(grantId: string, inferenceId: string, patch: Partial<InferenceRecord>): Promise<InferenceRecord> {
    const key = `${grantId}:${inferenceId}`
    const current = this.inferences.get(key)
    if (!current) throw new Error('inference not found')
    Object.assign(current, patch)
    return current
  }
  async appendEvent(event: EventRecord): Promise<void> {
    const list = this.events.get(event.matchId) ?? []
    if (list.some((item) => item.seq === event.seq)) throw new Error('duplicate event seq')
    list.push(event)
    this.events.set(event.matchId, list)
  }
  async listEvents(matchId: string): Promise<EventRecord[]> {
    return [...(this.events.get(matchId) ?? [])]
  }
}
