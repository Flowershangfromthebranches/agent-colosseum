import { describe, expect, it } from 'vitest'
import { defaultStakeSpec, newDeviceId, newGrantId, newInferenceId, newMatchId, newRoomId } from '@agent-colosseum/protocol'
import { PostgresStore } from './postgres.ts'

type Row = Record<string, unknown>

function pool(handler: (sql: string, args?: unknown[]) => { rows: Row[]; rowCount?: number } | Promise<{ rows: Row[]; rowCount?: number }>) {
  return {
    async query(sql: string, args?: unknown[]) { return handler(sql, args) },
    async connect() {
      return {
        query: async (sql: string, args?: unknown[]) => handler(sql, args),
        release() {},
      }
    },
  }
}

const deviceRow = {
  device_id: newDeviceId(), ed25519_public_key: 'e', x25519_public_key: 'x', created_at: 1, last_seen_at: 1,
}

describe('PostgresStore', () => {
  it('maps devices, rooms, grants and deducts under a lock', async () => {
    const grantId = newGrantId()
    const inferenceId = newInferenceId()
    const store = new PostgresStore(pool((sql) => {
      if (sql.includes('SELECT 1')) return { rows: [{ ok: 1 }] }
      if (sql.includes('FROM devices')) return { rows: [deviceRow] }
      if (sql.includes('FROM grants')) {
        return { rows: [{
          grant_id: grantId, owner_device_id: newDeviceId(), winner_device_id: newDeviceId(),
          model: 'm', provider: 'p', calls_remaining: 2, active_concurrency: 0, online_ms_remaining: 1,
          owner_online: true, status: 'active', status_reason: 'active', version: 1, stake_id: 's',
          last_online_tick_at: null,
        }] }
      }
      if (sql.includes('FROM inferences')) {
        return { rows: [{
          grant_id: grantId, inference_id: inferenceId, requester_device_id: 'a', owner_device_id: 'b',
          status: 'reserved', deducted: false, request_hash: 'h', started_at: null, finished_at: null, terminal_reason: null,
        }] }
      }
      return { rows: [], rowCount: 1 }
    }) as never)
    expect(await store.ping()).toBe(true)
    expect(await store.getDevice('x')).toBeTruthy()
    const deducted = await store.deductIfStarted(grantId, inferenceId)
    expect(deducted.callsRemaining).toBe(1)
  })

  it('rolls back a failed deduct and covers remaining SQL mappers', async () => {
    const store = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('ROLLBACK') || sql.includes('COMMIT')) return { rows: [] }
      return { rows: [] }
    }) as never)
    await expect(store.deductIfStarted(newGrantId(), newInferenceId())).rejects.toThrow(/missing/)

    const roomId = newRoomId()
    const matchId = newMatchId()
    const grantId = newGrantId()
    let consume = 1
    const mapped = new PostgresStore(pool((sql) => {
      if (sql.includes('UPDATE invites')) return { rows: [], rowCount: consume-- }
      if (sql.includes('INSERT INTO invites')) return { rows: [] }
      if (sql.includes('INSERT INTO devices')) return { rows: [] }
      if (sql.includes('ed25519_public_key')) return { rows: [deviceRow] }
      if (sql.includes('x25519_public_key')) return { rows: [] }
      if (sql.includes('FROM rooms') && sql.includes('room_code')) {
        return { rows: [{
          room_id: roomId, room_code: 'ABC234', host_device_id: deviceRow.device_id, guest_device_id: null,
          host_stake: JSON.stringify(defaultStakeSpec(String(deviceRow.device_id), 'openai-compatible', 'm', 'n'.repeat(16), 's')),
          guest_stake: null, host_accepted: false, guest_accepted: false, match_id: null, status: 'open',
        }] }
      }
      if (sql.includes('FROM rooms')) {
        return { rows: [{
          room_id: roomId, room_code: 'ABC234', host_device_id: deviceRow.device_id, guest_device_id: deviceRow.device_id,
          host_stake: defaultStakeSpec(String(deviceRow.device_id), 'openai-compatible', 'm', 'n'.repeat(16), 's'),
          guest_stake: defaultStakeSpec(String(deviceRow.device_id), 'openai-compatible', 'm2', 'n'.repeat(16), 's'),
          host_accepted: true, guest_accepted: true, match_id: matchId, status: 'matched',
        }] }
      }
      if (sql.includes("status IN ('live','pending_entropy')")) {
        return { rows: [{
          match_id: matchId, room_id: roomId, device_a: deviceRow.device_id, device_b: deviceRow.device_id,
          commitment: 'c', server_seed_hex: '00', entropy_a: 'aa', entropy_b: null, status: 'live',
          winner_device_id: null, settled: false, state: JSON.stringify(null), created_at: 1,
        }] }
      }
      if (sql.includes('FROM matches')) {
        return { rows: [{
          match_id: matchId, room_id: roomId, device_a: deviceRow.device_id, device_b: deviceRow.device_id,
          commitment: 'c', server_seed_hex: '00', entropy_a: null, entropy_b: null, status: 'live',
          winner_device_id: null, settled: false, state: null, created_at: 1,
        }] }
      }
      if (sql.includes('FROM stakes')) {
        return { rows: [{ stake_id: 's1', match_id: matchId, spec: JSON.stringify(defaultStakeSpec(String(deviceRow.device_id), 'openai-compatible', 'm', 'n'.repeat(16), 's')), status: 'locked' }] }
      }
      if (sql.includes('FROM grants')) {
        return { rows: [{
          grant_id: grantId, owner_device_id: deviceRow.device_id, winner_device_id: deviceRow.device_id,
          model: 'm', provider: 'p', calls_remaining: 1, active_concurrency: 0, online_ms_remaining: 1,
          owner_online: false, status: 'active', status_reason: 'active', version: 1, stake_id: 's',
          last_online_tick_at: 9,
        }] }
      }
      if (sql.includes('requester_device_id') && sql.includes('finished_at IS NULL')) {
        return { rows: [{
          grant_id: grantId, inference_id: 'i', requester_device_id: 'a', owner_device_id: 'b',
          status: 'started', deducted: true, request_hash: 'h', started_at: 1, finished_at: null, terminal_reason: null,
        }] }
      }
      if (sql.includes('FROM inferences')) {
        return { rows: [{
          grant_id: grantId, inference_id: 'i', requester_device_id: 'a', owner_device_id: 'b',
          status: 'started', deducted: true, request_hash: 'h', started_at: 1, finished_at: 2, terminal_reason: 'ok',
        }] }
      }
      if (sql.includes('FROM match_events')) return { rows: [{ seq: 0, hash: 'h', payload: { type: 'x' } }] }
      if (sql.includes('SELECT 1')) return { rows: [{ ok: 0 }] }
      return { rows: [], rowCount: 1 }
    }) as never)

    expect(await mapped.consumeInvite('h')).toBe(true)
    expect(await mapped.consumeInvite('h')).toBe(false)
    await mapped.seedInvite('h', 2)
    await mapped.putDevice({
      deviceId: String(deviceRow.device_id), ed25519PublicKey: 'e', x25519PublicKey: 'x', createdAt: 1, lastSeenAt: 1,
    })
    expect(await mapped.findDeviceByEd25519('e')).toBeTruthy()
    expect(await mapped.findDeviceByX25519('x')).toBeUndefined()
    await mapped.touchDevice('d', 2)
    await mapped.putRoom({
      roomId, roomCode: 'ABC234', hostDeviceId: String(deviceRow.device_id), guestDeviceId: null,
      hostStake: defaultStakeSpec(String(deviceRow.device_id), 'openai-compatible', 'm', 'n'.repeat(16), 's'),
      guestStake: null, hostAccepted: false, guestAccepted: false, matchId: null, status: 'open',
    })
    expect(await mapped.findRoomByCode('ABC234')).toBeTruthy()
    expect((await mapped.updateRoom(roomId, { hostAccepted: true })).hostAccepted).toBe(true)
    await mapped.putMatch({
      matchId, roomId, deviceA: String(deviceRow.device_id), deviceB: String(deviceRow.device_id),
      commitment: 'c', serverSeedHex: '00', entropyA: null, entropyB: null, status: 'live',
      winnerDeviceId: null, settled: false, state: null, createdAt: 1,
    })
    expect((await mapped.listLiveMatches()).length).toBe(1)
    await mapped.saveMatchState(matchId, { status: 'live' })
    await mapped.putStake({
      stakeId: 's1', matchId, spec: defaultStakeSpec(String(deviceRow.device_id), 'openai-compatible', 'm', 'n'.repeat(16), 's'), status: 'locked',
    })
    expect((await mapped.listStakes(matchId)).length).toBe(1)
    expect(await mapped.getGrant(grantId)).toBeTruthy()
    expect((await mapped.listGrantsForWinner(String(deviceRow.device_id))).length).toBe(1)
    expect((await mapped.listGrantsForOwner(String(deviceRow.device_id))).length).toBe(1)
    await mapped.saveGrant({
      grantId, ownerDeviceId: String(deviceRow.device_id), winnerDeviceId: String(deviceRow.device_id),
      model: 'm', provider: 'p', callsRemaining: 1, activeConcurrency: 0, onlineMsRemaining: 1,
      ownerOnline: false, status: 'active', statusReason: 'active', version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    expect(await mapped.getInference(grantId, 'i')).toBeTruthy()
    expect((await mapped.listOpenInferencesForRequester('a')).length).toBe(1)
    expect(await mapped.insertInference({
      grantId, inferenceId: newInferenceId(), requesterDeviceId: newDeviceId(), ownerDeviceId: newDeviceId(),
      status: 'reserved', deducted: false, requestHash: 'h', startedAt: null, finishedAt: null, terminalReason: null,
    })).toBe('created')
    await mapped.updateInference({
      grantId, inferenceId: 'i', requesterDeviceId: 'a', ownerDeviceId: 'b',
      status: 'completed', deducted: true, requestHash: 'h', startedAt: 1, finishedAt: 2, terminalReason: 'ok',
    })
    await mapped.appendEvent(matchId, 0, 'h', { type: 'x' })
    expect((await mapped.listEvents(matchId))[0]?.hash).toBe('h')
    expect(await mapped.ping()).toBe(false)
  })

  it('settles with grant, returns existing, and rolls back', async () => {
    const matchId = newMatchId()
    let settled = false
    const store = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return { rows: [] }
      if (sql.includes('FOR UPDATE') && sql.includes('matches')) {
        return { rows: [{ match_id: matchId, settled }] }
      }
      if (sql.includes('FROM grants')) {
        return { rows: [{
          grant_id: newGrantId(), owner_device_id: newDeviceId(), winner_device_id: newDeviceId(),
          model: 'm', provider: 'p', calls_remaining: 1, active_concurrency: 0, online_ms_remaining: 1,
          owner_online: false, status: 'active', status_reason: 'active', version: 1, stake_id: 's',
          last_online_tick_at: null,
        }] }
      }
      if (sql.includes('UPDATE matches')) { settled = true; return { rows: [] } }
      if (sql.includes('FROM stakes') || sql.includes('UPDATE stakes') || sql.includes('INSERT INTO grants')) return { rows: [] }
      return { rows: [] }
    }) as never)
    const grant = {
      grantId: newGrantId(), ownerDeviceId: newDeviceId(), winnerDeviceId: newDeviceId(),
      model: 'm', provider: 'p', callsRemaining: 10, activeConcurrency: 0, onlineMsRemaining: 1,
      ownerOnline: false, status: 'active' as const, statusReason: 'active' as const, version: 1,
      stakeId: 's', lastOnlineTickAt: null,
    }
    const first = await store.settleInTransaction({
      matchId, winnerDeviceId: grant.winnerDeviceId, reason: 'bust', grant,
      stakeUpdates: [{ stakeId: 's', status: 'converted' }],
    })
    expect(first.first).toBe(true)
    const again = await store.settleInTransaction({
      matchId, winnerDeviceId: grant.winnerDeviceId, reason: 'bust',
      stakeUpdates: [{ stakeId: 's', status: 'converted' }],
    })
    expect(again.first).toBe(false)

    const missing = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return { rows: [] }
      if (sql.includes('FOR UPDATE')) return { rows: [] }
      return { rows: [] }
    }) as never)
    await expect(missing.settleInTransaction({
      matchId, winnerDeviceId: null, reason: 'draw_released', stakeUpdates: [],
    })).rejects.toThrow(/match not found/)

    const missingMatch = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return { rows: [] }
      if (sql.includes('FOR UPDATE')) return { rows: [] }
      return { rows: [] }
    }) as never)
    await expect(missingMatch.saveMatchState(matchId, { status: 'live' })).rejects.toThrow(/match not found/)
  })

  it('treats unique inference inserts as duplicates and rethrows other errors', async () => {
    const dup = new PostgresStore(pool(() => { throw new Error('duplicate key value unique') }) as never)
    expect(await dup.insertInference({
      grantId: newGrantId(), inferenceId: newInferenceId(), requesterDeviceId: newDeviceId(), ownerDeviceId: newDeviceId(),
      status: 'reserved', deducted: false, requestHash: 'h', startedAt: null, finishedAt: null, terminalReason: null,
    })).toBe('duplicate')
    const boom = new PostgresStore(pool(() => { throw new Error('disk') }) as never)
    await expect(boom.insertInference({
      grantId: newGrantId(), inferenceId: newInferenceId(), requesterDeviceId: newDeviceId(), ownerDeviceId: newDeviceId(),
      status: 'reserved', deducted: false, requestHash: 'h', startedAt: null, finishedAt: null, terminalReason: null,
    })).rejects.toThrow(/disk/)
  })

  it('replays deducted inferences and exhausts the last call', async () => {
    const grantId = newGrantId()
    const inferenceId = newInferenceId()
    let deducted = true
    const replay = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT')) return { rows: [] }
      if (sql.includes('FROM grants')) {
        return { rows: [{
          grant_id: grantId, owner_device_id: newDeviceId(), winner_device_id: newDeviceId(),
          model: 'm', provider: 'p', calls_remaining: 1, active_concurrency: 0, online_ms_remaining: 1,
          owner_online: true, status: 'active', status_reason: 'active', version: 1, stake_id: 's',
          last_online_tick_at: null,
        }] }
      }
      if (sql.includes('FROM inferences')) {
        return { rows: [{
          grant_id: grantId, inference_id: inferenceId, requester_device_id: 'a', owner_device_id: 'b',
          status: 'started', deducted, request_hash: 'h', started_at: 1, finished_at: null, terminal_reason: null,
        }] }
      }
      return { rows: [] }
    }) as never)
    expect((await replay.deductIfStarted(grantId, inferenceId)).callsRemaining).toBe(1)

    deducted = false
    const last = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.startsWith('UPDATE') || sql.includes('UPDATE grants') || sql.includes('UPDATE inferences')) return { rows: [] }
      if (sql.includes('FROM grants')) {
        return { rows: [{
          grant_id: grantId, owner_device_id: newDeviceId(), winner_device_id: newDeviceId(),
          model: 'm', provider: 'p', calls_remaining: 1, active_concurrency: 0, online_ms_remaining: 1,
          owner_online: true, status: 'active', status_reason: 'active', version: 1, stake_id: 's',
          last_online_tick_at: null,
        }] }
      }
      if (sql.includes('FROM inferences')) {
        return { rows: [{
          grant_id: grantId, inference_id: inferenceId, requester_device_id: 'a', owner_device_id: 'b',
          status: 'reserved', deducted: false, request_hash: 'h', started_at: null, finished_at: null, terminal_reason: null,
        }] }
      }
      return { rows: [] }
    }) as never)
    const spent = await last.deductIfStarted(grantId, inferenceId)
    expect(spent.status).toBe('exhausted')

    const busy = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return { rows: [] }
      if (sql.includes('FROM grants')) {
        return { rows: [{
          grant_id: grantId, owner_device_id: newDeviceId(), winner_device_id: newDeviceId(),
          model: 'm', provider: 'p', calls_remaining: 2, active_concurrency: 1, online_ms_remaining: 1,
          owner_online: true, status: 'active', status_reason: 'active', version: 1, stake_id: 's',
          last_online_tick_at: null,
        }] }
      }
      if (sql.includes('FROM inferences')) {
        return { rows: [{
          grant_id: grantId, inference_id: inferenceId, requester_device_id: 'a', owner_device_id: 'b',
          status: 'reserved', deducted: false, request_hash: 'h', started_at: null, finished_at: null, terminal_reason: null,
        }] }
      }
      return { rows: [] }
    }) as never)
    await expect(busy.deductIfStarted(grantId, inferenceId)).rejects.toThrow(/CONCURRENCY/)

    const empty = new PostgresStore(pool((sql) => {
      if (sql.includes('BEGIN') || sql.includes('ROLLBACK')) return { rows: [] }
      if (sql.includes('FROM grants')) {
        return { rows: [{
          grant_id: grantId, owner_device_id: newDeviceId(), winner_device_id: newDeviceId(),
          model: 'm', provider: 'p', calls_remaining: 0, active_concurrency: 0, online_ms_remaining: 1,
          owner_online: true, status: 'active', status_reason: 'active', version: 1, stake_id: 's',
          last_online_tick_at: null,
        }] }
      }
      if (sql.includes('FROM inferences')) {
        return { rows: [{
          grant_id: grantId, inference_id: inferenceId, requester_device_id: 'a', owner_device_id: 'b',
          status: 'reserved', deducted: false, request_hash: 'h', started_at: null, finished_at: null, terminal_reason: null,
        }] }
      }
      return { rows: [] }
    }) as never)
    await expect(empty.deductIfStarted(grantId, inferenceId)).rejects.toThrow(/GRANT_EXHAUSTED/)
  })
})
