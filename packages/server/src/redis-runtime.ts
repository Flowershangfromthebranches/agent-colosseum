import { HEARTBEAT_TIMEOUT_MS } from '@agent-colosseum/protocol'
import type { ClockBoard, ClockHandlers } from './clocks.ts'
import type { PresenceBook } from './presence.ts'

type Outbound = { type: string; payload: unknown }

export type RedisLike = {
  hgetall(key: string): Promise<Record<string, string>>
  hset(key: string, ...fieldValues: Array<string | number>): Promise<number>
  hincrby(key: string, field: string, increment: number): Promise<number>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, field: string): Promise<number>
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  zadd(key: string, score: number, member: string): Promise<number>
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>
  zrem(key: string, member: string): Promise<number>
  zcard(key: string): Promise<number>
  publish(channel: string, message: string): Promise<number>
  subscribe(...channels: string[]): Promise<unknown>
  on(event: 'message', handler: (channel: string, message: string) => void): unknown
  duplicate(): RedisLike
  disconnect(): void
  ping(): Promise<string>
}

export interface FrameBus {
  publish(instanceId: string, deviceId: string, frame: Outbound): Promise<void>
  listen(handler: (deviceId: string, frame: Outbound) => void): void
  close(): void
}

export interface RateLimiter {
  remember(deviceId: string, messageId: string): Promise<void>
}

const PRESENCE = (id: string) => `arena:presence:${id}`
const SEEN = (deviceId: string, messageId: string) => `arena:seen:${deviceId}:${messageId}`
const RATE = (deviceId: string, window: number) => `arena:rl:${deviceId}:${window}`
const ACTION_Z = 'arena:clocks:action'
const ACTION_SEQ = 'arena:clocks:action:seq'
const DISC_Z = 'arena:clocks:disconnect'
const FRAMES = 'arena:frames'
const MAX_MESSAGES_PER_SECOND = 60

export class RedisPresence implements PresenceBook {
  private readonly cache = new Map<string, { lastBeat: number; sockets: number; disconnectedAt: number | null }>()

  constructor(
    private readonly redis: RedisLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  connect(deviceId: string, now = this.now()): void {
    const current = this.cache.get(deviceId) ?? { lastBeat: now, sockets: 0, disconnectedAt: null }
    current.sockets += 1
    current.lastBeat = now
    current.disconnectedAt = null
    this.cache.set(deviceId, current)
    void this.flush(deviceId)
  }

  disconnect(deviceId: string, now = this.now()): void {
    const current = this.cache.get(deviceId) ?? { lastBeat: now, sockets: 0, disconnectedAt: now }
    current.sockets = Math.max(0, current.sockets - 1)
    if (current.sockets === 0 && current.disconnectedAt === null) current.disconnectedAt = now
    this.cache.set(deviceId, current)
    void this.flush(deviceId)
  }

  beat(deviceId: string, now = this.now()): void {
    const current = this.cache.get(deviceId)
    if (current) {
      current.lastBeat = now
      if (current.sockets > 0) current.disconnectedAt = null
      void this.flush(deviceId)
    }
  }

  isOnline(deviceId: string, now = this.now()): boolean {
    const row = this.cache.get(deviceId)
    return Boolean(row && row.sockets > 0 && now - row.lastBeat <= HEARTBEAT_TIMEOUT_MS)
  }

  offlineSince(deviceId: string, now = this.now()): number | null {
    if (this.isOnline(deviceId, now)) return null
    const row = this.cache.get(deviceId)
    if (!row) return null
    if (row.disconnectedAt !== null) return Math.max(0, now - row.disconnectedAt)
    return Math.max(0, now - row.lastBeat)
  }

  socketsOf(deviceId: string): number {
    return this.cache.get(deviceId)?.sockets ?? 0
  }

  async refresh(deviceId: string): Promise<void> {
    const hash = await this.redis.hgetall(PRESENCE(deviceId))
    if (!hash || Object.keys(hash).length === 0) return
    const disconnectedRaw = hash.disconnectedAt
    const disconnectedAt = disconnectedRaw === undefined || disconnectedRaw === ''
      ? null
      : Number(disconnectedRaw)
    this.cache.set(deviceId, {
      sockets: Number(hash.sockets ?? 0),
      lastBeat: Number(hash.lastBeat ?? 0),
      disconnectedAt: disconnectedAt !== null && Number.isFinite(disconnectedAt) ? disconnectedAt : null,
    })
  }

  private async flush(deviceId: string): Promise<void> {
    const row = this.cache.get(deviceId)
    if (!row) return
    await this.redis.hset(
      PRESENCE(deviceId),
      'sockets', row.sockets,
      'lastBeat', row.lastBeat,
      'disconnectedAt', row.disconnectedAt ?? '',
    )
  }
}

export class RedisClocks implements ClockBoard {
  private readonly locals = new Map<string, ReturnType<typeof setTimeout>>()
  private poller: ReturnType<typeof setInterval> | null

  constructor(
    private readonly redis: RedisLike,
    private readonly handlers: ClockHandlers,
    private readonly now: () => number = () => Date.now(),
    autostart = true,
  ) {
    this.poller = autostart
      ? setInterval(() => { void this.due() }, 200)
      : null
    this.poller?.unref()
  }

  scheduleAction(matchId: string, actionSeq: number, delayMs = 60_000): void {
    const dueAt = this.now() + delayMs
    void this.redis.zadd(ACTION_Z, dueAt, matchId)
    void this.redis.hset(ACTION_SEQ, matchId, String(actionSeq))
    this.arm(`act:${matchId}`, delayMs)
  }

  scheduleDisconnect(matchId: string, delayMs: number): void {
    const dueAt = this.now() + delayMs
    void this.redis.zadd(DISC_Z, dueAt, matchId)
    this.arm(`disc:${matchId}`, delayMs)
  }

  cancelAction(matchId: string): void {
    void this.redis.zrem(ACTION_Z, matchId)
    void this.redis.hdel(ACTION_SEQ, matchId)
    this.clear(`act:${matchId}`)
  }

  cancelMatch(matchId: string): void {
    this.cancelAction(matchId)
    void this.redis.zrem(DISC_Z, matchId)
    this.clear(`disc:${matchId}`)
  }

  dispose(): void {
    if (this.poller) clearInterval(this.poller)
    this.poller = null
    for (const key of Array.from(this.locals.keys())) this.clear(key)
  }

  get size(): number {
    return this.locals.size
  }

  async due(now = this.now()): Promise<void> {
    const actions = await this.redis.zrangebyscore(ACTION_Z, 0, now)
    for (const matchId of actions) {
      const removed = await this.redis.zrem(ACTION_Z, matchId)
      if (removed === 0) continue
      const seq = Number((await this.redis.hget(ACTION_SEQ, matchId)) ?? '-1')
      this.clear(`act:${matchId}`)
      this.handlers.onActionTimeout(matchId, seq)
    }
    const disconnects = await this.redis.zrangebyscore(DISC_Z, 0, now)
    for (const matchId of disconnects) {
      const removed = await this.redis.zrem(DISC_Z, matchId)
      if (removed === 0) continue
      this.clear(`disc:${matchId}`)
      this.handlers.onDisconnectCheck(matchId)
    }
  }

  private arm(key: string, delayMs: number): void {
    this.clear(key)
    const timer = setTimeout(() => {
      this.locals.delete(key)
      void this.due()
    }, Math.max(0, delayMs))
    timer.unref()
    this.locals.set(key, timer)
  }

  private clear(key: string): void {
    const timer = this.locals.get(key)
    if (timer) clearTimeout(timer)
    this.locals.delete(key)
  }
}

export class RedisRateLimit implements RateLimiter {
  constructor(private readonly redis: RedisLike, private readonly now: () => number = () => Date.now()) {}

  async remember(deviceId: string, messageId: string): Promise<void> {
    const stored = await this.redis.set(SEEN(deviceId, messageId), '1', 'EX', 120, 'NX')
    if (stored === null || stored === undefined) throw new Error('REPLAY')
    const window = Math.floor(this.now() / 1000)
    const count = await this.redis.incr(RATE(deviceId, window))
    await this.redis.expire(RATE(deviceId, window), 2)
    if (count > MAX_MESSAGES_PER_SECOND) throw new Error('RATE_LIMIT')
  }
}

export class RedisBus implements FrameBus {
  private handler: ((deviceId: string, frame: Outbound) => void) | null = null
  private started = false

  constructor(
    private readonly pub: RedisLike,
    private readonly sub: RedisLike,
    private readonly instanceId = 'local',
  ) {}

  listen(handler: (deviceId: string, frame: Outbound) => void): void {
    this.handler = handler
    if (this.started) return
    this.started = true
    this.sub.on('message', (channel, message) => {
      if (channel !== FRAMES) return
      const parsed = JSON.parse(message) as { instanceId: string; deviceId: string; frame: Outbound }
      if (parsed.instanceId === this.instanceId) return
      this.handler?.(parsed.deviceId, parsed.frame)
    })
    void this.sub.subscribe(FRAMES)
  }

  async publish(instanceId: string, deviceId: string, frame: Outbound): Promise<void> {
    await this.pub.publish(FRAMES, JSON.stringify({ instanceId, deviceId, frame }))
  }

  close(): void {
    this.handler = null
    this.sub.disconnect()
  }
}

export class MemoryRedis implements RedisLike {
  hashes = new Map<string, Map<string, string>>()
  strings = new Map<string, string>()
  zsets = new Map<string, Map<string, number>>()
  channels = new Map<string, Array<(channel: string, message: string) => void>>()
  private messageHandler: ((channel: string, message: string) => void) | null = null
  twins: MemoryRedis[] = []

  duplicate(): RedisLike {
    const twin = new MemoryRedis()
    twin.hashes = this.hashes
    twin.strings = this.strings
    twin.zsets = this.zsets
    twin.channels = this.channels
    this.twins.push(twin)
    twin.twins.push(this)
    return twin
  }

  on(event: 'message', handler: (channel: string, message: string) => void): unknown {
    this.messageHandler = handler
    return this
  }

  async subscribe(...channels: string[]): Promise<unknown> {
    for (const channel of channels) {
      const list = this.channels.get(channel) ?? []
      if (this.messageHandler) list.push(this.messageHandler)
      this.channels.set(channel, list)
    }
    return 'OK'
  }

  async publish(channel: string, message: string): Promise<number> {
    const handlers = this.channels.get(channel) ?? []
    for (const handler of handlers) handler(channel, message)
    return handlers.length
  }

  async ping(): Promise<string> { return 'PONG' }
  disconnect(): void { this.messageHandler = null }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? [])
  }

  async hset(key: string, ...fieldValues: Array<string | number>): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>()
    for (let i = 0; i < fieldValues.length; i += 2) {
      hash.set(String(fieldValues[i]), String(fieldValues[i + 1]))
    }
    this.hashes.set(key, hash)
    return fieldValues.length / 2
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, string>()
    const next = Number(hash.get(field) ?? 0) + increment
    hash.set(field, String(next))
    this.hashes.set(key, hash)
    return next
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null
  }

  async hdel(key: string, field: string): Promise<number> {
    return this.hashes.get(key)?.delete(field) ? 1 : 0
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<string | null> {
    const nx = args.some((item) => item === 'NX')
    if (nx && this.strings.has(key)) return null
    this.strings.set(key, value)
    return 'OK'
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? 0) + 1
    this.strings.set(key, String(next))
    return next
  }

  async expire(_key: string, _seconds: number): Promise<number> { return 1 }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const zset = this.zsets.get(key) ?? new Map<string, number>()
    zset.set(member, score)
    this.zsets.set(key, zset)
    return 1
  }

  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    const zset = this.zsets.get(key) ?? new Map<string, number>()
    const lo = Number(min)
    const hi = Number(max)
    return [...zset.entries()].filter(([, score]) => score >= lo && score <= hi).map(([member]) => member)
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.zsets.get(key)?.delete(member) ? 1 : 0
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0
  }
}
