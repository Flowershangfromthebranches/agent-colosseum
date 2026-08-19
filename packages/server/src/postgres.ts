import pg from 'pg'
import type { InferenceCallV1 } from '@agent-colosseum/protocol'
import type { ArenaStore, DeviceRecord, GrantRecord, MatchRecord, RoomRecord, StakeRecord } from './store.ts'

export class PostgresStore implements ArenaStore {
  constructor(private readonly pool: pg.Pool) {}

  async consumeInvite(codeHash: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE invites SET uses_remaining = uses_remaining - 1
       WHERE code_hash = $1 AND uses_remaining > 0`,
      [codeHash],
    )
    return (rowCount ?? 0) > 0
  }

  async seedInvite(codeHash: string, uses: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO invites (code_hash, uses_remaining, max_uses) VALUES ($1,$2,$2)
       ON CONFLICT (code_hash) DO NOTHING`,
      [codeHash, uses],
    )
  }

  async putDevice(device: DeviceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO devices (device_id, ed25519_public_key, x25519_public_key, created_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [device.deviceId, device.ed25519PublicKey, device.x25519PublicKey, device.createdAt, device.lastSeenAt],
    )
  }

  async getDevice(deviceId: string) {
    const { rows } = await this.pool.query('SELECT * FROM devices WHERE device_id = $1', [deviceId])
    return rows[0] ? mapDevice(rows[0]) : undefined
  }
  async findDeviceByEd25519(key: string) {
    const { rows } = await this.pool.query('SELECT * FROM devices WHERE ed25519_public_key = $1', [key])
    return rows[0] ? mapDevice(rows[0]) : undefined
  }
  async findDeviceByX25519(key: string) {
    const { rows } = await this.pool.query('SELECT * FROM devices WHERE x25519_public_key = $1', [key])
    return rows[0] ? mapDevice(rows[0]) : undefined
  }
  async touchDevice(deviceId: string, at: number) {
    await this.pool.query('UPDATE devices SET last_seen_at = $2 WHERE device_id = $1', [deviceId, at])
  }

  async putRoom(room: RoomRecord) {
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
  async getRoom(roomId: string) {
    const { rows } = await this.pool.query('SELECT * FROM rooms WHERE room_id = $1', [roomId])
    return rows[0] ? mapRoom(rows[0]) : undefined
  }
  async findRoomByCode(code: string) {
    const { rows } = await this.pool.query('SELECT * FROM rooms WHERE room_code = $1', [code])
    return rows[0] ? mapRoom(rows[0]) : undefined
  }
  async updateRoom(roomId: string, patch: Partial<RoomRecord>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query('SELECT * FROM rooms WHERE room_id = $1 FOR UPDATE', [roomId])
      if (!locked.rows[0]) throw new Error('room not found')
      const next = { ...mapRoom(locked.rows[0]), ...patch }
      await client.query(
        `UPDATE rooms SET guest_device_id=$2, guest_stake=$3, host_accepted=$4, guest_accepted=$5, match_id=$6, status=$7
         WHERE room_id=$1`,
        [roomId, next.guestDeviceId, next.guestStake ? JSON.stringify(next.guestStake) : null, next.hostAccepted, next.guestAccepted, next.matchId, next.status],
      )
      await client.query('COMMIT')
      return next
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async putMatch(match: MatchRecord) {
    await this.pool.query(
      `INSERT INTO matches (match_id, room_id, device_a, device_b, commitment, server_seed_hex, entropy_a, entropy_b,
        status, winner_device_id, settled, state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        match.matchId, match.roomId, match.deviceA, match.deviceB, match.commitment, match.serverSeedHex,
        match.entropyA, match.entropyB, match.status, match.winnerDeviceId, match.settled,
        JSON.stringify(match.state), match.createdAt,
      ],
    )
  }
  async getMatch(matchId: string) {
    const { rows } = await this.pool.query('SELECT * FROM matches WHERE match_id = $1', [matchId])
    return rows[0] ? mapMatch(rows[0]) : undefined
  }
  async listLiveMatches() {
    const { rows } = await this.pool.query(`SELECT * FROM matches WHERE status IN ('live','pending_entropy')`)
    return rows.map(mapMatch)
  }
  async saveMatchState(matchId: string, patch: Partial<MatchRecord>) {
    const current = await this.getMatch(matchId)
    if (!current) throw new Error('match not found')
    const next = { ...current, ...patch }
    await this.pool.query(
      `UPDATE matches SET entropy_a=$2, entropy_b=$3, status=$4, state=$5, winner_device_id=$6 WHERE match_id=$1`,
      [matchId, next.entropyA, next.entropyB, next.status, JSON.stringify(next.state), next.winnerDeviceId],
    )
  }

  async settleInTransaction(input: {
    matchId: string
    winnerDeviceId: string | null
    reason: string
    grant?: GrantRecord
    stakeUpdates: Array<{ stakeId: string; status: StakeRecord['status'] }>
  }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query('SELECT * FROM matches WHERE match_id = $1 FOR UPDATE', [input.matchId])
      const match = locked.rows[0]
      if (!match) throw new Error('match not found')
      if (match.settled) {
        const existing = await client.query('SELECT * FROM grants WHERE stake_id IN (SELECT stake_id FROM stakes WHERE match_id = $1)', [input.matchId])
        await client.query('COMMIT')
        return { first: false, grant: existing.rows[0] ? mapGrant(existing.rows[0]) : null }
      }
      await client.query(
        `UPDATE matches SET settled = TRUE, status = 'terminal', winner_device_id = $2 WHERE match_id = $1`,
        [input.matchId, input.winnerDeviceId],
      )
      for (const update of input.stakeUpdates) {
        await client.query('SELECT stake_id FROM stakes WHERE stake_id = $1 FOR UPDATE', [update.stakeId])
        await client.query('UPDATE stakes SET status = $2 WHERE stake_id = $1', [update.stakeId, update.status])
      }
      if (input.grant) {
        const g = input.grant
        await client.query(
          `INSERT INTO grants (grant_id, owner_device_id, winner_device_id, model, provider, calls_remaining,
            active_concurrency, online_ms_remaining, owner_online, status, status_reason, version, stake_id, last_online_tick_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            g.grantId, g.ownerDeviceId, g.winnerDeviceId, g.model, g.provider, g.callsRemaining,
            g.activeConcurrency, g.onlineMsRemaining, g.ownerOnline, g.status, g.statusReason, g.version, g.stakeId, g.lastOnlineTickAt,
          ],
        )
      }
      await client.query('COMMIT')
      return { first: true, grant: input.grant ?? null }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async putStake(stake: StakeRecord) {
    await this.pool.query('INSERT INTO stakes (stake_id, match_id, spec, status) VALUES ($1,$2,$3,$4)', [
      stake.stakeId, stake.matchId, JSON.stringify(stake.spec), stake.status,
    ])
  }
  async listStakes(matchId: string) {
    const { rows } = await this.pool.query('SELECT * FROM stakes WHERE match_id = $1', [matchId])
    return rows.map(mapStake)
  }
  async getGrant(grantId: string) {
    const { rows } = await this.pool.query('SELECT * FROM grants WHERE grant_id = $1', [grantId])
    return rows[0] ? mapGrant(rows[0]) : undefined
  }
  async listGrantsForWinner(deviceId: string) {
    const { rows } = await this.pool.query('SELECT * FROM grants WHERE winner_device_id = $1', [deviceId])
    return rows.map(mapGrant)
  }
  async saveGrant(grant: GrantRecord) {
    await this.pool.query(
      `UPDATE grants SET calls_remaining=$2, active_concurrency=$3, online_ms_remaining=$4, owner_online=$5,
        status=$6, status_reason=$7, version=$8, last_online_tick_at=$9 WHERE grant_id=$1`,
      [
        grant.grantId, grant.callsRemaining, grant.activeConcurrency, grant.onlineMsRemaining, grant.ownerOnline,
        grant.status, grant.statusReason, grant.version, grant.lastOnlineTickAt,
      ],
    )
  }
  async getInference(grantId: string, inferenceId: string) {
    const { rows } = await this.pool.query(
      'SELECT * FROM inferences WHERE grant_id = $1 AND inference_id = $2',
      [grantId, inferenceId],
    )
    return rows[0] ? mapInference(rows[0]) : undefined
  }
  async insertInference(record: InferenceCallV1) {
    try {
      await this.pool.query(
        `INSERT INTO inferences (grant_id, inference_id, requester_device_id, owner_device_id, status, deducted,
          request_hash, started_at, finished_at, terminal_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          record.grantId, record.inferenceId, record.requesterDeviceId, record.ownerDeviceId, record.status,
          record.deducted, record.requestHash, record.startedAt, record.finishedAt, record.terminalReason,
        ],
      )
      return 'created'
    } catch (error) {
      if (error instanceof Error && /duplicate|unique/i.test(error.message)) return 'duplicate'
      throw error
    }
  }
  async deductIfStarted(grantId: string, inferenceId: string): Promise<GrantRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const grantRes = await client.query('SELECT * FROM grants WHERE grant_id = $1 FOR UPDATE', [grantId])
      const infRes = await client.query(
        'SELECT * FROM inferences WHERE grant_id = $1 AND inference_id = $2 FOR UPDATE',
        [grantId, inferenceId],
      )
      if (!grantRes.rows[0] || !infRes.rows[0]) throw new Error('missing')
      const grant = mapGrant(grantRes.rows[0])
      const inference = mapInference(infRes.rows[0])
      if (inference.deducted) {
        await client.query('COMMIT')
        return grant
      }
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
      await client.query(
        `UPDATE grants SET calls_remaining=$2, active_concurrency=$3, version=$4, status=$5, status_reason=$6 WHERE grant_id=$1`,
        [grant.grantId, grant.callsRemaining, grant.activeConcurrency, grant.version, grant.status, grant.statusReason],
      )
      await client.query(
        `UPDATE inferences SET status=$3, deducted=$4, started_at=$5 WHERE grant_id=$1 AND inference_id=$2`,
        [grantId, inferenceId, inference.status, inference.deducted, inference.startedAt],
      )
      await client.query('COMMIT')
      return grant
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async updateInference(record: InferenceCallV1) {
    await this.pool.query(
      `UPDATE inferences SET status=$3, deducted=$4, started_at=$5, finished_at=$6, terminal_reason=$7
       WHERE grant_id=$1 AND inference_id=$2`,
      [record.grantId, record.inferenceId, record.status, record.deducted, record.startedAt, record.finishedAt, record.terminalReason],
    )
  }
  async appendEvent(matchId: string, seq: number, hash: string, payload: unknown) {
    await this.pool.query(
      'INSERT INTO match_events (match_id, seq, hash, payload) VALUES ($1,$2,$3,$4)',
      [matchId, seq, hash, JSON.stringify(payload)],
    )
  }
  async listEvents(matchId: string) {
    const { rows } = await this.pool.query('SELECT * FROM match_events WHERE match_id = $1 ORDER BY seq', [matchId])
    return rows.map((row) => ({ seq: row.seq, hash: row.hash, payload: row.payload }))
  }
  async ping() {
    const { rows } = await this.pool.query('SELECT 1 AS ok')
    return rows[0]?.ok === 1
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
function asJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
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
    deviceA: String(row.device_a),
    deviceB: String(row.device_b),
    commitment: String(row.commitment),
    serverSeedHex: String(row.server_seed_hex),
    entropyA: row.entropy_a ? String(row.entropy_a) : null,
    entropyB: row.entropy_b ? String(row.entropy_b) : null,
    status: row.status as MatchRecord['status'],
    winnerDeviceId: row.winner_device_id ? String(row.winner_device_id) : null,
    settled: Boolean(row.settled),
    state: row.state ? asJson(row.state) : null,
    createdAt: Number(row.created_at),
  }
}
function mapStake(row: Record<string, unknown>): StakeRecord {
  return { stakeId: String(row.stake_id), matchId: String(row.match_id), spec: asJson(row.spec), status: row.status as StakeRecord['status'] }
}
function mapGrant(row: Record<string, unknown>): GrantRecord {
  return {
    grantId: String(row.grant_id),
    ownerDeviceId: String(row.owner_device_id),
    winnerDeviceId: String(row.winner_device_id),
    model: String(row.model),
    provider: String(row.provider),
    callsRemaining: Number(row.calls_remaining),
    activeConcurrency: Number(row.active_concurrency),
    onlineMsRemaining: Number(row.online_ms_remaining),
    ownerOnline: Boolean(row.owner_online),
    status: row.status as GrantRecord['status'],
    statusReason: row.status_reason as GrantRecord['statusReason'],
    version: Number(row.version),
    stakeId: String(row.stake_id),
    lastOnlineTickAt: row.last_online_tick_at === null ? null : Number(row.last_online_tick_at),
  }
}
function mapInference(row: Record<string, unknown>): InferenceCallV1 {
  return {
    grantId: String(row.grant_id),
    inferenceId: String(row.inference_id),
    requesterDeviceId: String(row.requester_device_id),
    ownerDeviceId: String(row.owner_device_id),
    status: row.status as InferenceCallV1['status'],
    deducted: Boolean(row.deducted),
    requestHash: String(row.request_hash),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    terminalReason: row.terminal_reason === null ? null : String(row.terminal_reason),
  }
}
