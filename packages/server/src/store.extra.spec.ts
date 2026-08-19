import { describe, expect, it } from 'vitest'
import { defaultStakeSpec, newDeviceId, newGrantId, newInferenceId, newMatchId, newRoomId } from '@agent-colosseum/protocol'
import { MemoryStore } from './store.ts'

describe('memory store extras', () => {
  it('covers room, match, grant list and event helpers', async () => {
    const store = new MemoryStore()
    const device = { deviceId: newDeviceId(), ed25519PublicKey: 'e', x25519PublicKey: 'x', createdAt: 1, lastSeenAt: 1 }
    await store.putDevice(device)
    await store.touchDevice(device.deviceId, 2)
    expect(await store.findDeviceByX25519('x')).toBeTruthy()
    const roomId = newRoomId()
    await store.putRoom({
      roomId, roomCode: 'ABC234', hostDeviceId: device.deviceId, guestDeviceId: null,
      hostStake: defaultStakeSpec(device.deviceId, 'openai-compatible', 'm', 'n', 's'),
      guestStake: null, hostAccepted: false, guestAccepted: false, matchId: null, status: 'open',
    })
    expect(await store.findRoomByCode('ABC234')).toBeTruthy()
    await store.updateRoom(roomId, { hostAccepted: true })
    await expect(store.updateRoom(newRoomId(), {})).rejects.toThrow()
    const matchId = newMatchId()
    await store.putMatch({
      matchId, roomId, deviceA: device.deviceId, deviceB: newDeviceId(), commitment: 'c',
      serverSeedHex: '00', entropyA: null, entropyB: null, status: 'live', winnerDeviceId: null,
      settled: false, state: null, createdAt: 1,
    })
    expect((await store.listLiveMatches()).length).toBe(1)
    await store.saveMatchState(matchId, { status: 'terminal' })
    const grantId = newGrantId()
    await store.saveGrant({
      grantId, ownerDeviceId: device.deviceId, winnerDeviceId: device.deviceId, model: 'm',
      provider: 'p', callsRemaining: 1, activeConcurrency: 0, onlineMsRemaining: 1, ownerOnline: false,
      status: 'active', statusReason: 'active', version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    expect((await store.listGrantsForWinner(device.deviceId)).length).toBe(1)
    expect((await store.listGrantsForOwner(device.deviceId)).length).toBe(1)
    expect(await store.listOpenInferencesForRequester(device.deviceId)).toEqual([])
    await store.appendEvent(matchId, 0, 'h', { type: 'x' })
    expect((await store.listEvents(matchId)).length).toBe(1)
    await expect(store.appendEvent(matchId, 0, 'h', {})).rejects.toThrow(/duplicate/)
    expect(await store.consumeInvite('missing')).toBe(false)
    expect(await store.findDeviceByEd25519('e')).toBeTruthy()
    expect(await store.getMatch(matchId)).toBeTruthy()
    expect(await store.getRoom(roomId)).toBeTruthy()
    expect(await store.ping()).toBe(true)
    const inferenceId = newInferenceId()
    await store.insertInference({
      grantId, inferenceId, requesterDeviceId: device.deviceId, ownerDeviceId: device.deviceId,
      status: 'reserved', deducted: false, requestHash: 'h', startedAt: null, finishedAt: null, terminalReason: null,
    })
    const started = await store.deductIfStarted(grantId, inferenceId)
    expect(started.callsRemaining).toBe(0)
    expect(started.status).toBe('exhausted')
    expect((await store.deductIfStarted(grantId, inferenceId)).callsRemaining).toBe(0)
    const extra = newGrantId()
    await store.insertInference({
      grantId, inferenceId: extra, requesterDeviceId: device.deviceId, ownerDeviceId: device.deviceId,
      status: 'reserved', deducted: false, requestHash: 'h2', startedAt: null, finishedAt: null, terminalReason: null,
    })
    await expect(store.deductIfStarted(grantId, extra)).rejects.toThrow(/GRANT_EXHAUSTED|CONCURRENCY/)
    await expect(store.deductIfStarted(newGrantId(), extra)).rejects.toThrow(/missing/)
    await expect(store.saveMatchState(newMatchId(), {})).rejects.toThrow(/match not found/)
    await expect(store.settleInTransaction({
      matchId: newMatchId(), winnerDeviceId: null, reason: 'x', stakeUpdates: [],
    })).rejects.toThrow(/match not found/)
    await expect(store.settleInTransaction({
      matchId, winnerDeviceId: null, reason: 'x', stakeUpdates: [{ stakeId: 'missing', status: 'released' }],
    })).rejects.toThrow(/stake not found/)
    await store.putDevice({
      deviceId: newDeviceId(), ed25519PublicKey: 'e2', x25519PublicKey: 'x2', createdAt: 1, lastSeenAt: 1,
    })
    await expect(store.putDevice({
      deviceId: device.deviceId, ed25519PublicKey: 'e3', x25519PublicKey: 'x3', createdAt: 1, lastSeenAt: 1,
    })).rejects.toThrow(/IDENTITY/)
  })
})
