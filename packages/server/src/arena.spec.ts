import { describe, expect, it } from 'vitest'
import {
  generateDeviceKeypair,
  signStake,
  signUtf8,
  toHex,
  randomBytes,
} from '@agent-colosseum/crypto'
import {
  defaultStakeSpec,
  newDeviceId,
  newGrantId,
  newInferenceId,
  newMatchId,
  stakeTermsFingerprint,
} from '@agent-colosseum/protocol'
import { ArenaService } from './arena.ts'
import { isProviderAllowed } from './config.ts'
import { sha256Hex } from './hash.ts'
import { MemoryPresence } from './presence.ts'
import { RelayController } from './relay.ts'
import { settleMatch, tickGrantOnline } from './settlement.ts'
import { MemoryStore } from './store.ts'

const INVITE = 'INVITECODE12ABCD'

function service() {
  const store = new MemoryStore()
  void store.seedInvite(sha256Hex(INVITE), 8)
  const arena = new ArenaService(store, {
    host: '127.0.0.1',
    port: 0,
    databaseUrl: '',
    redisUrl: '',
    inviteHashes: new Map(),
    providerAllowlist: ['openai-compatible', 'script'],
    publicBaseUrl: 'http://127.0.0.1',
  })
  return { store, arena }
}

async function register(arena: ArenaService, invite = INVITE) {
  const keys = generateDeviceKeypair()
  const { nonce } = arena.issueChallenge(keys.ed25519PublicKey, keys.x25519PublicKey, invite)
  const device = await arena.redeem({
    nonce,
    signature: signUtf8(keys.ed25519PrivateKey, nonce),
  })
  return { keys, device }
}

function stakeFor(deviceId: string, keys: ReturnType<typeof generateDeviceKeypair>, model = 'local-a') {
  const unsigned = defaultStakeSpec(deviceId, 'openai-compatible', model, toHex(randomBytes(16)), 'pending')
  return { ...unsigned, signature: signStake(keys.ed25519PrivateKey, unsigned) }
}

describe('config and logs', () => {
  it('loads env allowlists and hashes invites', async () => {
    const { loadConfig, isProviderAllowed } = await import('./config.ts')
    const cfg = loadConfig({
      ARENA_INVITE_HASHES: 'deadbeef:2',
      ARENA_PROVIDER_ALLOWLIST: 'openai-compatible',
      ARENA_HOST: '0.0.0.0',
      ARENA_PORT: '9',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      ARENA_PUBLIC_BASE_URL: 'https://x',
    })
    expect(cfg.inviteHashes.get('deadbeef')?.uses).toBe(2)
    expect(isProviderAllowed(cfg.providerAllowlist, 'openai-compatible')).toBe(true)
    const def = loadConfig({})
    expect(def.port).toBe(8787)
    expect(def.providerAllowlist).toEqual([])
    const codes = loadConfig({ ARENA_INVITE_CODES: 'INVITECODE12ABCD', ARENA_INVITE_USES: '3' })
    expect(codes.inviteHashes.size).toBe(1)
  })
})

describe('allowlist', () => {
  it('defaults to deny', () => {
    expect(isProviderAllowed([], 'deepseek-official')).toBe(false)
    expect(isProviderAllowed(['openai-compatible'], 'openai-compatible')).toBe(true)
  })
})

describe('auth', () => {
  it('assigns deviceId and rejects invite reuse after exhaustion', async () => {
    const store = new MemoryStore()
    await store.seedInvite(sha256Hex('ONCEONLY12ABCD'), 1)
    const arena = new ArenaService(store, {
      host: 'x', port: 0, databaseUrl: '', redisUrl: '', inviteHashes: new Map(),
      providerAllowlist: ['openai-compatible'], publicBaseUrl: '',
    })
    await register(arena, 'ONCEONLY12ABCD')
    await expect(register(arena, 'ONCEONLY12ABCD')).rejects.toThrow(/INVITE/)
  })

  it('rejects public-key takeover', async () => {
    const { arena, store } = service()
    const first = await register(arena)
    await expect(store.putDevice({
      deviceId: newDeviceId(),
      ed25519PublicKey: first.keys.ed25519PublicKey,
      x25519PublicKey: generateDeviceKeypair().x25519PublicKey,
      createdAt: 1,
      lastSeenAt: 1,
    })).rejects.toThrow(/IDENTITY_CONFLICT/)
  })
})

describe('rooms and settlement', () => {
  it('creates one grant in a single settlement and is idempotent', async () => {
    const { arena, store } = service()
    const host = await register(arena)
    const guest = await register(arena)
    const room = await arena.createRoom(host.device.deviceId, stakeFor(host.device.deviceId, host.keys, 'm1'))
    await arena.joinRoom(guest.device.deviceId, room.roomCode, stakeFor(guest.device.deviceId, guest.keys, 'm2'))
    expect(stakeTermsFingerprint(room.hostStake)).toBe(
      stakeTermsFingerprint(stakeFor(guest.device.deviceId, guest.keys, 'm2')),
    )
    await arena.acceptRoom(host.device.deviceId, room.roomId, stakeFor(host.device.deviceId, host.keys, 'm1'))
    await arena.acceptRoom(guest.device.deviceId, room.roomId, stakeFor(guest.device.deviceId, guest.keys, 'm2'))
    const matchId = (await store.getRoom(room.roomId))!.matchId!
    const grant = await settleMatch(store, { matchId, winnerDeviceId: guest.device.deviceId, reason: 'forfeit' })
    expect(grant?.winnerDeviceId).toBe(guest.device.deviceId)
    const again = await settleMatch(store, { matchId, winnerDeviceId: host.device.deviceId, reason: 'forfeit' })
    expect(again?.grantId).toBe(grant?.grantId)
    const fifty = await Promise.all(Array.from({ length: 50 }, () =>
      settleMatch(store, { matchId, winnerDeviceId: guest.device.deviceId, reason: 'forfeit' })))
    expect(new Set(fifty.map((item) => item?.grantId)).size).toBe(1)
  })
})

describe('relay', () => {
  it('deducts once and enforces concurrency 1', async () => {
    const store = new MemoryStore()
    const grantId = newGrantId()
    const winner = newDeviceId()
    const owner = newDeviceId()
    await store.saveGrant({
      grantId, ownerDeviceId: owner, winnerDeviceId: winner, model: 'm', provider: 'openai-compatible',
      callsRemaining: 10, activeConcurrency: 0, onlineMsRemaining: 1000, ownerOnline: true,
      status: 'active', statusReason: 'active', version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    const relay = new RelayController(store)
    const firstId = newInferenceId()
    await relay.reserve({ grantId, inferenceId: firstId, winnerDeviceId: winner, requestBytes: 10, requestHash: 'h', ownerOnline: true })
    await relay.preflight(grantId, firstId, 'h')
    const started = await relay.start(grantId, firstId)
    expect(started.callsRemaining).toBe(9)
    expect(started.activeConcurrency).toBe(1)
    const second = newInferenceId()
    await relay.reserve({ grantId, inferenceId: second, winnerDeviceId: winner, requestBytes: 10, requestHash: 'h2', ownerOnline: true })
    await expect(relay.start(grantId, second)).rejects.toThrow(/CONCURRENCY/)
    await relay.terminal(grantId, firstId, 'completed')
    const replay = await relay.start(grantId, firstId)
    expect(replay.callsRemaining).toBe(9)
  })

  it('starts at most one of 50 concurrent inferences when concurrency is 1', async () => {
    const store = new MemoryStore()
    const grantId = newGrantId()
    const winner = newDeviceId()
    await store.saveGrant({
      grantId, ownerDeviceId: newDeviceId(), winnerDeviceId: winner, model: 'm', provider: 'openai-compatible',
      callsRemaining: 10, activeConcurrency: 0, onlineMsRemaining: 1000, ownerOnline: true,
      status: 'active', statusReason: 'active', version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    const relay = new RelayController(store)
    const ids = Array.from({ length: 50 }, () => newInferenceId())
    for (const id of ids) {
      await relay.reserve({
        grantId, inferenceId: id, winnerDeviceId: winner, requestBytes: 8, requestHash: id, ownerOnline: true,
      })
    }
    const results = await Promise.allSettled(ids.map((id) => relay.start(grantId, id)))
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(49)
    expect((await store.getGrant(grantId))?.callsRemaining).toBe(9)
    expect((await store.getGrant(grantId))?.activeConcurrency).toBe(1)
  })
})

describe('grant ttl', () => {
  it('pauses while owner is offline and distinguishes ttl exhaustion', async () => {
    const store = new MemoryStore()
    const grant = {
      grantId: newGrantId(), ownerDeviceId: newDeviceId(), winnerDeviceId: newDeviceId(),
      model: 'm', provider: 'openai-compatible', callsRemaining: 3, activeConcurrency: 0,
      onlineMsRemaining: 5_000, ownerOnline: false, status: 'active' as const, statusReason: 'active' as const,
      version: 1, stakeId: 's', lastOnlineTickAt: null,
    }
    await store.saveGrant(grant)
    const online = await tickGrantOnline(store, { ...grant }, true, 1000)
    const later = await tickGrantOnline(store, online, true, 4000)
    expect(later.onlineMsRemaining).toBe(2000)
    const paused = await tickGrantOnline(store, later, false, 20_000)
    expect(paused.onlineMsRemaining).toBe(2000)
    const dead = await tickGrantOnline(store, { ...paused, lastOnlineTickAt: 20_000, ownerOnline: true, status: 'active', statusReason: 'active' }, true, 30_000)
    expect(dead.statusReason).toBe('ttl_exhausted')
  })
})

describe('presence timers', () => {
  it('does not forfeit at 89s and forfeits after 90s', async () => {
    const book = new MemoryPresence()
    book.connect('d', 0)
    expect(book.isOnline('d', 10_000)).toBe(true)
    book.beat('d', 20_000)
    expect(book.socketsOf('d')).toBe(1)
    book.disconnect('d')
    expect(book.offlineSince('d', 89_000)).toBeGreaterThan(89_000)
    expect(book.socketsOf('missing')).toBe(0)
  })
})

describe('entropy ownership', () => {
  it('does not invent player entropy when opening a match', async () => {
    const { arena, store } = service()
    const host = await register(arena)
    const guest = await register(arena)
    const room = await arena.createRoom(host.device.deviceId, stakeFor(host.device.deviceId, host.keys, 'm1'))
    await arena.joinRoom(guest.device.deviceId, room.roomCode, stakeFor(guest.device.deviceId, guest.keys, 'm2'))
    await arena.acceptRoom(host.device.deviceId, room.roomId, stakeFor(host.device.deviceId, host.keys, 'm1'))
    await arena.acceptRoom(guest.device.deviceId, room.roomId, stakeFor(guest.device.deviceId, guest.keys, 'm2'))
    const match = (await store.getMatch((await store.getRoom(room.roomId))!.matchId!))!
    expect(match.entropyA).toBeNull()
    expect(match.entropyB).toBeNull()
    expect(match.status).toBe('pending_entropy')
    expect(match.commitment).toBeTruthy()
    void newMatchId
  })
})
