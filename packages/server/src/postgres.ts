import pg from 'pg'
import type {
  ArenaStore,
  DeviceRecord,
  EventRecord,
  GrantRecord,
  InferenceRecord,
  MatchRecord,
  RoomRecord,
  StakeRecord,
} from './store.ts'

export class PostgresStore implements ArenaStore {
  constructor(private readonly pool: pg.Pool) {}

  async putDevice(device: DeviceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO devices (device_id, ed25519_public_key, x25519_public_key, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (device_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [device.deviceId, device.ed25519PublicKey, device.x25519PublicKey, device.createdAt, device.lastSeenAt],
    )
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM devices WHERE device_id = $1', [deviceId])
    return rows[0] ? mapDevice(rows[0]) : undefined
  }

  async findDeviceByPubkey(ed25519PublicKey: string): Promise<DeviceRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM devices WHERE ed25519_public_key = $1', [ed25519PublicKey])
    return rows[0] ? mapDevice(rows[0]) : undefined
  }

  async touchDevice(deviceId: string, at: number): Promise<void> {
    await this.pool.query('UPDATE devices SET last_seen_at = $2 WHERE device_id = $1', [deviceId, at])
  }

  async putRoom(room: RoomRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO rooms (room_id, room_code, host_device_id, guest_device_id, host_stake, guest_stake,
        host_accepted, guest_accepted, match_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        room.roomId, room.roomCode, room.hostDeviceId, room.guestDeviceId,
        JSON.stringify(room.hostStake), room.guestStake ? JSON.stringify(room.guestStake) : null,
        room.hostAccepted, room.guestAccepted, room.matchId, room.status,
      ],
    )
  }

  async getRoom(roomId: string): Promise<RoomRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM rooms WHERE room_id = $1', [roomId])
    return rows[0] ? mapRoom(rows[0]) : undefined
  }

  async findRoomByCode(code: string): Promise<RoomRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM rooms WHERE room_code = $1', [code])
    return rows[0] ? mapRoom(rows[0]) : undefined
  }

  async updateRoom(roomId: string, patch: Partial<RoomRecord>): Promise<RoomRecord> {
    const current = await this.getRoom(roomId)
    if (!current) throw new Error('room not found')
    const next = { ...current, ...patch }
    await this.pool.query(
      `UPDATE rooms SET guest_device_id=$2, guest_stake=$3, host_accepted=$4, guest_accepted=$5,
        match_id=$6, status=$7 WHERE room_id=$1`,
      [
        roomId, next.guestDeviceId, next.guestStake ? JSON.stringify(next.guestStake) : null,
        next.hostAccepted, next.guestAccepted, next.matchId, next.status,
      ],
    )
    return next
  }

  async putMatch(match: MatchRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO matches (match_id, room_id, button_device_id, bb_device_id, server_seed_hex, commitment,
        player_entropy, status, winner_device_id, settled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        match.matchId, match.roomId, match.buttonDeviceId, match.bbDeviceId, match.serverSeedHex,
        match.commitment, JSON.stringify(match.playerEntropy), match.status, match.winnerDeviceId,
        match.settled, match.createdAt,
      ],
    )
  }

  async getMatch(matchId: string): Promise<MatchRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM matches WHERE match_id = $1', [matchId])
    return rows[0] ? mapMatch(rows[0]) : undefined
  }

  async settleMatch(matchId: string, winnerDeviceId: string | null): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE matches SET settled = TRUE, status = 'terminal', winner_device_id = $2
       WHERE match_id = $1 AND settled = FALSE`,
      [matchId, winnerDeviceId],
    )
    return (rowCount ?? 0) > 0
  }

  async putStake(stake: StakeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO stakes (stake_id, match_id, spec, status) VALUES ($1,$2,$3,$4)`,
      [stake.stakeId, stake.matchId, JSON.stringify(stake.spec), stake.status],
    )
  }

  async listStakes(matchId: string): Promise<StakeRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM stakes WHERE match_id = $1', [matchId])
    return rows.map(mapStake)
  }

  async updateStake(stakeId: string, status: StakeRecord['status']): Promise<void> {
    await this.pool.query('UPDATE stakes SET status = $2 WHERE stake_id = $1', [stakeId, status])
  }

  async putGrant(grant: GrantRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO grants (grant_id, owner_device_id, winner_device_id, model, provider, calls_remaining,
        online_ms_remaining, owner_online, status, version, stake_id, last_online_tick_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        grant.grantId, grant.ownerDeviceId, grant.winnerDeviceId, grant.model, grant.provider,
        grant.callsRemaining, grant.onlineMsRemaining, grant.ownerOnline, grant.status, grant.version,
        grant.stakeId, grant.lastOnlineTickAt,
      ],
    )
  }

  async getGrant(grantId: string): Promise<GrantRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM grants WHERE grant_id = $1', [grantId])
    return rows[0] ? mapGrant(rows[0]) : undefined
  }

  async listGrantsForWinner(deviceId: string): Promise<GrantRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM grants WHERE winner_device_id = $1', [deviceId])
    return rows.map(mapGrant)
  }

  async saveGrant(grant: GrantRecord): Promise<void> {
    await this.pool.query(
      `UPDATE grants SET calls_remaining=$2, online_ms_remaining=$3, owner_online=$4, status=$5,
        version=$6, last_online_tick_at=$7 WHERE grant_id=$1`,
      [
        grant.grantId, grant.callsRemaining, grant.onlineMsRemaining, grant.ownerOnline, grant.status,
        grant.version, grant.lastOnlineTickAt,
      ],
    )
  }

  async reserveInference(record: InferenceRecord): Promise<'created' | 'duplicate'> {
    try {
      await this.pool.query(
        `INSERT INTO inferences (grant_id, inference_id, status, deducted, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [record.grantId, record.inferenceId, record.status, record.deducted, record.createdAt],
      )
      return 'created'
    } catch (error) {
      if (error instanceof Error && /duplicate|unique/i.test(error.message)) return 'duplicate'
      throw error
    }
  }

  async getInference(grantId: string, inferenceId: string): Promise<InferenceRecord | undefined> {
    const { rows } = await this.pool.query(
      'SELECT * FROM inferences WHERE grant_id = $1 AND inference_id = $2',
      [grantId, inferenceId],
    )
    return rows[0] ? mapInference(rows[0]) : undefined
  }

  async updateInference(grantId: string, inferenceId: string, patch: Partial<InferenceRecord>): Promise<InferenceRecord> {
    const current = await this.getInference(grantId, inferenceId)
    if (!current) throw new Error('inference not found')
    const next = { ...current, ...patch }
    await this.pool.query(
      `UPDATE inferences SET status=$3, deducted=$4 WHERE grant_id=$1 AND inference_id=$2`,
      [grantId, inferenceId, next.status, next.deducted],
    )
    return next
  }

  async appendEvent(event: EventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO match_events (match_id, seq, hash, payload) VALUES ($1,$2,$3,$4)`,
      [event.matchId, event.seq, event.hash, JSON.stringify(event.payload)],
    )
  }

  async listEvents(matchId: string): Promise<EventRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM match_events WHERE match_id = $1 ORDER BY seq ASC',
      [matchId],
    )
    return rows.map((row) => ({
      matchId: row.match_id,
      seq: row.seq,
      hash: row.hash,
      payload: row.payload,
    }))
  }
}

function mapDevice(row: Record<string, unknown>): DeviceRecord {
  return {
    deviceId: String(row.device_id),
    ed25519PublicKey: String(row.ed25519_public_key),
    x25519PublicKey: String(row.x25519_public_key),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  }
}

function mapRoom(row: Record<string, unknown>): RoomRecord {
  return {
    roomId: String(row.room_id),
    roomCode: String(row.room_code),
    hostDeviceId: String(row.host_device_id),
    guestDeviceId: row.guest_device_id ? String(row.guest_device_id) : null,
    hostStake: asJson(row.host_stake),
    guestStake: row.guest_stake ? asJson(row.guest_stake) : null,
    hostAccepted: Boolean(row.host_accepted),
    guestAccepted: Boolean(row.guest_accepted),
    matchId: row.match_id ? String(row.match_id) : null,
    status: row.status as RoomRecord['status'],
  }
}

function mapMatch(row: Record<string, unknown>): MatchRecord {
  return {
    matchId: String(row.match_id),
    roomId: String(row.room_id),
    buttonDeviceId: String(row.button_device_id),
    bbDeviceId: String(row.bb_device_id),
    serverSeedHex: String(row.server_seed_hex),
    commitment: String(row.commitment),
    playerEntropy: asJson(row.player_entropy),
    status: row.status as MatchRecord['status'],
    winnerDeviceId: row.winner_device_id ? String(row.winner_device_id) : null,
    settled: Boolean(row.settled),
    createdAt: Number(row.created_at),
  }
}

function mapStake(row: Record<string, unknown>): StakeRecord {
  return {
    stakeId: String(row.stake_id),
    matchId: String(row.match_id),
    spec: asJson(row.spec),
    status: row.status as StakeRecord['status'],
  }
}

function mapGrant(row: Record<string, unknown>): GrantRecord {
  return {
    grantId: String(row.grant_id),
    ownerDeviceId: String(row.owner_device_id),
    winnerDeviceId: String(row.winner_device_id),
    model: String(row.model),
    provider: String(row.provider),
    callsRemaining: Number(row.calls_remaining),
    onlineMsRemaining: Number(row.online_ms_remaining),
    ownerOnline: Boolean(row.owner_online),
    status: row.status as GrantRecord['status'],
    version: Number(row.version),
    stakeId: String(row.stake_id),
    lastOnlineTickAt: row.last_online_tick_at === null ? null : Number(row.last_online_tick_at),
  }
}

function mapInference(row: Record<string, unknown>): InferenceRecord {
  return {
    grantId: String(row.grant_id),
    inferenceId: String(row.inference_id),
    status: row.status as InferenceRecord['status'],
    deducted: Boolean(row.deducted),
    createdAt: Number(row.created_at),
  }
}

function asJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}
