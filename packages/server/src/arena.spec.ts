import { describe, expect, it } from 'vitest'
import { generateDeviceKeypair, signChallenge, signUtf8, verifyEventChain } from '@agent-colosseum/crypto'
import {
  DEFAULT_MAX_CALLS,
  defaultStakeSpec,
  newDeviceId,
  newGrantId,
  newInferenceId,
  newMatchId,
  stakeFingerprint,
} from '@agent-colosseum/protocol'
import { ArenaService } from './arena.ts'
import { isProviderAllowed } from './config.ts'
import { PresenceBook } from './presence.ts'
import { RelayController } from './relay.ts'
import { settleMatch, tickGrantOnline } from './settlement.ts'
import { MemoryStore } from './store.ts'

function service(allow = ['script']) {
  const store = new MemoryStore()
  const arena = new ArenaService(store, {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: '',
    redisUrl: '',
    inviteCodes: ['INVITECODE12ABCD'],
    providerAllowlist: allow,
    publicBaseUrl: 'http://127.0.0.1',
  })
  return { store, arena }
}

function stake(deviceId: string, signature = 'sig') {
  return defaultStakeSpec(deviceId, 'script', 'script-a', signature)
}

describe('allowlist', () => {
  it('defaults to deny', () => {
    expect(isProviderAllowed([], 'deepseek-official')).toBe(false)
    expect(isProviderAllowed(['script'], 'script')).toBe(true)
  })
})

describe('auth', () => {
  it('registers with invite + challenge signature', async () => {
    const { arena } = service()
    const deviceId = newDeviceId()
    const keys = generateDeviceKeypair(deviceId)
    const { nonce } = arena.issueChallenge(keys.ed25519PublicKey, keys.x25519PublicKey)
    const device = await arena.redeemChallenge({
      nonce,
      signature: signChallenge(keys.ed25519PrivateKey, nonce),
      inviteCode: 'INVITECODE12ABCD',
      deviceId,
    })
    expect(device.deviceId).toBe(deviceId)
    await expect(arena.redeemChallenge({
      nonce: 'missing',
      signature: 'x',
    })).rejects.toThrow(/expired/)
  })
})

describe('rooms + settlement', () => {
  it('creates a grant once and refuses a second settlement', async () => {
    const { arena, store } = service()
    const host = newDeviceId()
    const guest = newDeviceId()
    await store.putDevice({
      deviceId: host, ed25519PublicKey: 'h', x25519PublicKey: 'h', createdAt: 1, lastSeenAt: 1,
    })
    await store.putDevice({
      deviceId: guest, ed25519PublicKey: 'g', x25519PublicKey: 'g', createdAt: 1, lastSeenAt: 1,
    })
    const room = await arena.createRoom(host, stake(host))
    await arena.joinRoom(guest, room.roomCode, stake(guest))
    const accepted = await arena.acceptRoom(host, room.roomId)
    await arena.acceptRoom(guest, room.roomId)
    const matchId = (await store.getRoom(room.roomId))!.matchId!
    expect(accepted.roomId).toBe(room.roomId)
    const engine = arena.engines.get(matchId)!
    engine.forfeit('button')
    const grant = await settleMatch(store, {
      matchId,
      winnerDeviceId: guest,
      reason: 'forfeit',
    })
    expect(grant?.winnerDeviceId).toBe(guest)
    expect(grant?.callsRemaining).toBe(DEFAULT_MAX_CALLS)
    const again = await settleMatch(store, {
      matchId,
      winnerDeviceId: host,
      reason: 'forfeit',
    })
    expect(again).toBeNull()
    const stakes = await store.listStakes(matchId)
    expect(stakes.filter((item) => item.status === 'converted')).toHaveLength(1)
    expect(stakes.filter((item) => item.status === 'unlocked')).toHaveLength(1)
  })

  it('releases both stakes on double disconnect', async () => {
    const store = new MemoryStore()
    const matchId = newMatchId()
    await store.putMatch({
      matchId,
      roomId: 'r',
      buttonDeviceId: 'a',
      bbDeviceId: 'b',
      serverSeedHex: '00',
      commitment: '00',
      playerEntropy: ['00', '11'],
      status: 'live',
      winnerDeviceId: null,
      settled: false,
      createdAt: 1,
    })
    await store.putStake({ stakeId: 's1', matchId, spec: stake('a'), status: 'locked' })
    await store.putStake({ stakeId: 's2', matchId, spec: stake('b'), status: 'locked' })
    const grant = await settleMatch(store, { matchId, winnerDeviceId: null, reason: 'double_disconnect' })
    expect(grant).toBeNull()
    expect((await store.listStakes(matchId)).every((item) => item.status === 'released')).toBe(true)
  })
})

describe('relay', () => {
  it('deducts once per inference id and survives a replayed start', async () => {
    const store = new MemoryStore()
    const grantId = newGrantId()
    const inferenceId = newInferenceId()
    const owner = newDeviceId()
    const winner = newDeviceId()
    await store.putGrant({
      grantId,
      ownerDeviceId: owner,
      winnerDeviceId: winner,
      model: 'script-a',
      provider: 'script',
      callsRemaining: 10,
      onlineMsRemaining: 1000,
      ownerOnline: true,
      status: 'active',
      version: 1,
      stakeId: 'stake',
      lastOnlineTickAt: null,
    })
    const relay = new RelayController(store)
    const first = await relay.reserve({
      grantId, inferenceId, winnerDeviceId: winner, requestBytes: 12, estimatedInputTokens: 10, ownerOnline: true,
    })
    expect(first.created).toBe(true)
    const second = await relay.reserve({
      grantId, inferenceId, winnerDeviceId: winner, requestBytes: 12, estimatedInputTokens: 10, ownerOnline: true,
    })
    expect(second.created).toBe(false)
    const afterStart = await relay.inferenceStarted(grantId, inferenceId)
    expect(afterStart.callsRemaining).toBe(9)
    const replay = await relay.inferenceStarted(grantId, inferenceId)
    expect(replay.callsRemaining).toBe(9)
    await relay.terminal(grantId, inferenceId, 'cancelled')
    const again = await relay.terminal(grantId, inferenceId, 'completed')
    expect(again.status).toBe('cancelled')
  })
})

describe('grant ttl', () => {
  it('pauses while owner is offline', async () => {
    const store = new MemoryStore()
    const grant = {
      grantId: newGrantId(),
      ownerDeviceId: newDeviceId(),
      winnerDeviceId: newDeviceId(),
      model: 'm',
      provider: 'script',
      callsRemaining: 3,
      onlineMsRemaining: 10_000,
      ownerOnline: false,
      status: 'active' as const,
      version: 1,
      stakeId: 's',
      lastOnlineTickAt: null,
    }
    await store.putGrant(grant)
    const online = await tickGrantOnline(store, { ...grant }, true, 1_000)
    const later = await tickGrantOnline(store, online, true, 4_000)
    expect(later.onlineMsRemaining).toBe(7_000)
    const paused = await tickGrantOnline(store, later, false, 20_000)
    expect(paused.onlineMsRemaining).toBe(7_000)
    expect(paused.ownerOnline).toBe(false)
  })
})

describe('presence', () => {
  it('requires a live heartbeat window', () => {
    const book = new PresenceBook()
    book.connect('d', 0)
    expect(book.isOnline('d', 10_000)).toBe(true)
    expect(book.isOnline('d', 50_000)).toBe(false)
    book.beat('d', 50_000)
    expect(book.isOnline('d', 50_000)).toBe(true)
  })
})

describe('event chain', () => {
  it('keeps a verifiable hash chain after a room match starts', async () => {
    const { arena, store } = service()
    const host = newDeviceId()
    const guest = newDeviceId()
    await store.putDevice({
      deviceId: host, ed25519PublicKey: 'h2', x25519PublicKey: 'h2', createdAt: 1, lastSeenAt: 1,
    })
    await store.putDevice({
      deviceId: guest, ed25519PublicKey: 'g2', x25519PublicKey: 'g2', createdAt: 1, lastSeenAt: 1,
    })
    const room = await arena.createRoom(host, stake(host))
    await arena.joinRoom(guest, room.roomCode, stake(guest))
    await arena.acceptRoom(host, room.roomId)
    await arena.acceptRoom(guest, room.roomId)
    const matchId = (await store.getRoom(room.roomId))!.matchId!
    const events = await store.listEvents(matchId)
    expect(verifyEventChain(events)).toBe(true)
    expect(stakeFingerprint(stake(host))).toBe(stakeFingerprint(stake(host)))
    expect(signUtf8('aa'.repeat(32), 'payload')).toHaveLength(128)
  })
})
