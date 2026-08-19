import { describe, expect, it } from 'vitest'
import { DISCONNECT_FORFEIT_MS, HEARTBEAT_TIMEOUT_MS } from '@agent-colosseum/protocol'
import {
  MemoryRedis,
  RedisBus,
  RedisClocks,
  RedisPresence,
  RedisRateLimit,
} from './redis-runtime.ts'

describe('RedisPresence', () => {
  it('mirrors MemoryPresence locally and persists to Redis', async () => {
    const redis = new MemoryRedis()
    const book = new RedisPresence(redis)
    book.beat('ghost', 1)
    expect(book.isOnline('missing', 1)).toBe(false)
    expect(book.offlineSince('missing', 1)).toBeNull()
    book.disconnect('missing', 1)
    expect(book.offlineSince('missing', 1)).toBe(0)
    book.connect('d', 0)
    book.connect('d', 0)
    expect(book.socketsOf('d')).toBe(2)
    book.beat('d', 10)
    expect(book.isOnline('d', 10)).toBe(true)
    expect(book.isOnline('d', 10 + HEARTBEAT_TIMEOUT_MS + 1)).toBe(false)
    expect(book.offlineSince('d', 10 + HEARTBEAT_TIMEOUT_MS + 1)).toBeGreaterThan(0)
    book.disconnect('d', 20)
    book.disconnect('d', 20)
    expect(book.socketsOf('d')).toBe(0)
    expect(book.offlineSince('d', 20 + DISCONNECT_FORFEIT_MS)).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const other = new RedisPresence(redis)
    await other.refresh('missing-key')
    await other.refresh('d')
    expect(other.socketsOf('d')).toBe(0)
    expect(other.offlineSince('d', 20 + DISCONNECT_FORFEIT_MS)).not.toBeNull()
    await redis.hset('arena:presence:bad', 'sockets', 0, 'lastBeat', 1, 'disconnectedAt', 'nope')
    await other.refresh('bad')
    expect(other.socketsOf('bad')).toBe(0)
    await redis.hset('arena:presence:empty', 'sockets', 0, 'lastBeat', 3)
    await other.refresh('empty')
    expect(other.offlineSince('empty', 10)).not.toBeNull()
  })
})

describe('RedisClocks', () => {
  it('fires due timers from Redis and ignores stale members', async () => {
    const redis = new MemoryRedis()
    const actions: Array<{ matchId: string; seq: number }> = []
    const disconnects: string[] = []
    let now = 0
    const clocks = new RedisClocks(
      redis,
      {
        onActionTimeout(matchId, actionSeq) { actions.push({ matchId, seq: actionSeq }) },
        onDisconnectCheck(matchId) { disconnects.push(matchId) },
      },
      () => now,
      false,
    )
    clocks.scheduleAction('m1', 3, 5)
    clocks.scheduleAction('m1', 4, 5)
    clocks.scheduleDisconnect('m1', 5)
    clocks.scheduleDisconnect('m2', 30_000)
    now = 5
    await clocks.due()
    expect(actions).toEqual([{ matchId: 'm1', seq: 4 }])
    expect(disconnects).toEqual(['m1'])
    clocks.cancelAction('m2')
    clocks.cancelMatch('m2')
    clocks.scheduleAction('m3', 1, 30_000)
    expect(clocks.size).toBeGreaterThan(0)
    const raced = new MemoryRedis()
    raced.zrem = async () => 0
    await raced.zadd('arena:clocks:action', 0, 'stale')
    await raced.zadd('arena:clocks:disconnect', 0, 'stale')
    const skipped = new RedisClocks(raced, {
      onActionTimeout() { actions.push({ matchId: 'stale', seq: -1 }) },
      onDisconnectCheck() { disconnects.push('stale') },
    }, () => 1, false)
    await skipped.due(1)
    expect(actions.some((item) => item.matchId === 'stale')).toBe(false)
    skipped.dispose()
    const live = new RedisClocks(
      redis,
      {
        onActionTimeout(matchId, actionSeq) { actions.push({ matchId, seq: actionSeq }) },
        onDisconnectCheck() {},
      },
      () => Date.now(),
      true,
    )
    live.scheduleAction('armed', 9, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(actions.some((item) => item.matchId === 'armed')).toBe(true)
    live.dispose()
    clocks.dispose()
    expect(clocks.size).toBe(0)
  })
})

describe('RedisRateLimit', () => {
  it('rejects replayed message ids and caps messages per window', async () => {
    const redis = new MemoryRedis()
    const limit = new RedisRateLimit(redis, () => 1_000)
    await limit.remember('d', 'm1')
    await expect(limit.remember('d', 'm1')).rejects.toThrow(/REPLAY/)
    for (let i = 0; i < 59; i += 1) await limit.remember('d', `n${i}`)
    await expect(limit.remember('d', 'overflow')).rejects.toThrow(/RATE_LIMIT/)
  })
})

describe('MemoryRedis', () => {
  it('covers hash incr, expire, zcard and ping', async () => {
    const redis = new MemoryRedis()
    expect(await redis.ping()).toBe('PONG')
    expect(await redis.hincrby('k', 'n', 2)).toBe(2)
    expect(await redis.hget('k', 'n')).toBe('2')
    await redis.zadd('z', 1, 'm')
    expect(await redis.zcard('z')).toBe(1)
    expect(await redis.expire('k', 1)).toBe(1)
    expect(await redis.hdel('missing', 'x')).toBe(0)
  })
})

describe('RedisBus', () => {
  it('delivers published frames to other instances only', async () => {
    const pub = new MemoryRedis()
    const sub = pub.duplicate()
    const bus = new RedisBus(pub, sub, 'alpha')
    const seen: string[] = []
    bus.listen((deviceId) => { seen.push(deviceId) })
    await bus.publish('alpha', 'd1', { type: 'ping', payload: {} })
    expect(seen).toEqual([])
    await bus.publish('beta', 'd1', { type: 'ping', payload: {} })
    expect(seen).toEqual(['d1'])
    bus.listen((deviceId) => { seen.push(`again:${deviceId}`) })
    await pub.publish('other', JSON.stringify({ instanceId: 'beta', deviceId: 'd2', frame: { type: 'x', payload: {} } }))
    expect(seen.includes('d2')).toBe(false)
    bus.close()
  })
})
