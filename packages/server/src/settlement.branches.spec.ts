import { describe, expect, it } from 'vitest'
import { defaultStakeSpec, newDeviceId, newGrantId, newMatchId } from '@agent-colosseum/protocol'
import { settleMatch, tickGrantOnline } from './settlement.ts'
import { MemoryStore } from './store.ts'

async function twoStakes(store: MemoryStore, matchId: string, a: string, b: string) {
  await store.putMatch({
    matchId, roomId: 'r', deviceA: a, deviceB: b, commitment: 'c', serverSeedHex: '00',
    entropyA: null, entropyB: null, status: 'live', winnerDeviceId: null, settled: false, state: null, createdAt: 1,
  })
  await store.putStake({ stakeId: 's1', matchId, spec: defaultStakeSpec(a, 'openai-compatible', 'm1', 'n1', 'sig'), status: 'locked' })
  await store.putStake({ stakeId: 's2', matchId, spec: defaultStakeSpec(b, 'openai-compatible', 'm2', 'n2', 'sig'), status: 'locked' })
}

describe('settlement branches', () => {
  it('throws without two stakes and releases on every no-contest reason', async () => {
    const store = new MemoryStore()
    await expect(settleMatch(store, { matchId: newMatchId(), winnerDeviceId: null, reason: 'draw_released' }))
      .rejects.toThrow(/two stakes/)
    const matchId = newMatchId()
    const a = newDeviceId()
    const b = newDeviceId()
    await twoStakes(store, matchId, a, b)
    expect(await settleMatch(store, { matchId, winnerDeviceId: null, reason: 'draw_released' })).toBeNull()
    const m2 = newMatchId()
    await twoStakes(store, m2, a, b)
    expect(await settleMatch(store, { matchId: m2, winnerDeviceId: a, reason: 'server_fault' })).toBeNull()
    const m3 = newMatchId()
    await twoStakes(store, m3, a, b)
    expect(await settleMatch(store, { matchId: m3, winnerDeviceId: a, reason: 'double_disconnect' })).toBeNull()
    const m4 = newMatchId()
    await twoStakes(store, m4, a, b)
    const grant = await settleMatch(store, { matchId: m4, winnerDeviceId: a, reason: 'bust' })
    expect(grant?.winnerDeviceId).toBe(a)
  })

  it('ticks inactive grants without decrement and zeros TTL', async () => {
    const store = new MemoryStore()
    const inactive = {
      grantId: newGrantId(), ownerDeviceId: newDeviceId(), winnerDeviceId: newDeviceId(),
      model: 'm', provider: 'openai-compatible', callsRemaining: 1, activeConcurrency: 0,
      onlineMsRemaining: 5, ownerOnline: false, status: 'exhausted' as const, statusReason: 'calls_exhausted' as const,
      version: 1, stakeId: 's', lastOnlineTickAt: null,
    }
    await store.saveGrant(inactive)
    const ticked = await tickGrantOnline(store, { ...inactive }, true, 10)
    expect(ticked.status).toBe('exhausted')
    expect(ticked.onlineMsRemaining).toBe(5)
    const live = { ...inactive, grantId: newGrantId(), status: 'active' as const, statusReason: 'active' as const, lastOnlineTickAt: 0, onlineMsRemaining: 0 }
    await store.saveGrant(live)
    const dead = await tickGrantOnline(store, live, true, 1)
    expect(dead.statusReason).toBe('ttl_exhausted')
  })
})
