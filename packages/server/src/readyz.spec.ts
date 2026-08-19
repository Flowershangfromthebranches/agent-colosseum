import { describe, expect, it } from 'vitest'
import { ArenaService } from './arena.ts'
import { buildServer } from './http.ts'
import { MemoryStore } from './store.ts'
import { PokerEngine } from '@agent-colosseum/poker'
import { commitServerSeed, deriveHandDeck } from '@agent-colosseum/crypto'
import { uuidv7 } from '@agent-colosseum/protocol'

function arena(store = new MemoryStore()) {
  return new ArenaService(store, {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: '',
    redisUrl: '',
    inviteHashes: new Map(),
    providerAllowlist: ['openai-compatible'],
    publicBaseUrl: 'http://127.0.0.1',
  })
}

describe('readyz', () => {
  it('fails when postgres or redis is down and passes only after real pings', async () => {
    const service = arena()
    const downDb = await buildServer(service, service.config, {
      redisPing: async () => true,
    })
    service.store.ping = async () => false
    let res = await downDb.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json().db).toBe(false)

    const downRedis = await buildServer(arena(), service.config, {
      redisPing: async () => false,
    })
    res = await downRedis.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json().redis).toBe(false)

    const okStore = new MemoryStore()
    const ok = await buildServer(arena(okStore), service.config, {
      redisPing: async () => true,
    })
    res = await ok.inject({ method: 'GET', url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, db: true, redis: true })
    await downDb.close()
    await downRedis.close()
    await ok.close()
  })
})

describe('match restore', () => {
  it('reloads a live engine from persisted PokerMatchStateV1', async () => {
    const store = new MemoryStore()
    const matchId = uuidv7()
    const cards = deriveHandDeck({
      matchId,
      handNo: 1,
      serverSeedHex: commitServerSeed().serverSeedHex,
      playerEntropy: ['aa'.repeat(32), 'bb'.repeat(32)],
    })
    const engine = PokerEngine.create({
      matchId,
      deviceA: uuidv7(),
      deviceB: uuidv7(),
      deck: cards,
    })
    engine.startHand(cards)
    await store.putMatch({
      matchId,
      roomId: uuidv7(),
      deviceA: engine.state.players.A.deviceId,
      deviceB: engine.state.players.B.deviceId,
      commitment: 'c',
      serverSeedHex: '00',
      entropyA: 'aa',
      entropyB: 'bb',
      status: 'live',
      winnerDeviceId: null,
      settled: false,
      state: engine.toState(),
      createdAt: Date.now(),
    })
    const restored = arena(store)
    await restored.restoreLive()
    expect(restored.engines.get(matchId)?.state.handNo).toBe(1)
    expect(restored.engines.get(matchId)?.state.toAct).toBe('A')
  })
})
