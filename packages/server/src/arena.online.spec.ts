import { describe, expect, it } from 'vitest'
import {
  generateDeviceKeypair,
  signEntropy,
  signStake,
  signUtf8,
  toHex,
  randomBytes,
} from '@agent-colosseum/crypto'
import {
  PROTOCOL_VERSION,
  defaultStakeSpec,
  newInferenceId,
  newMessageId,
  uuidv7,
} from '@agent-colosseum/protocol'
import { ArenaService } from './arena.ts'
import { sha256Hex } from './hash.ts'
import { MemoryStore } from './store.ts'

const INVITE = 'INVITECODE12ABCD'

function service() {
  const store = new MemoryStore()
  void store.seedInvite(sha256Hex(INVITE), 8)
  return new ArenaService(store, {
    host: '127.0.0.1', port: 0, databaseUrl: '', redisUrl: '',
    inviteHashes: new Map(), providerAllowlist: ['openai-compatible'], publicBaseUrl: 'http://127.0.0.1',
  })
}

async function register(arena: ArenaService) {
  const keys = generateDeviceKeypair()
  const { nonce } = arena.issueChallenge(keys.ed25519PublicKey, keys.x25519PublicKey, INVITE)
  const device = await arena.redeem({ nonce, signature: signUtf8(keys.ed25519PrivateKey, nonce) })
  return { keys, device }
}

function stake(deviceId: string, keys: ReturnType<typeof generateDeviceKeypair>, model: string) {
  const unsigned = defaultStakeSpec(deviceId, 'openai-compatible', model, toHex(randomBytes(16)), 'pending')
  return { ...unsigned, signature: signStake(keys.ed25519PrivateKey, unsigned) }
}

function frame<T extends string>(type: T, payload: unknown) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: newMessageId(),
    sentAt: Date.now(),
    type,
    payload,
  }
}

describe('arena online handle', () => {
  it('opens a match after entropy and applies a fold', async () => {
    const arena = service()
    const host = await register(arena)
    const guest = await register(arena)
    const inbox: Array<{ who: string; type: string }> = []
    arena.attach(host.device.deviceId, (f) => inbox.push({ who: 'h', type: f.type }))
    arena.attach(guest.device.deviceId, (f) => inbox.push({ who: 'g', type: f.type }))
    await arena.handle(host.device.deviceId, frame('room.create', { stake: stake(host.device.deviceId, host.keys, 'm1') }) as never)
    const created = inbox.find((item) => item.type === 'room.created')
    expect(created).toBeTruthy()
    const room = [...(arena.store as MemoryStore).rooms.values()][0]!
    await arena.handle(guest.device.deviceId, frame('room.join', {
      roomCode: room.roomCode,
      stake: stake(guest.device.deviceId, guest.keys, 'm2'),
    }) as never)
    await arena.handle(host.device.deviceId, frame('room.accept', {
      roomId: room.roomId, stake: stake(host.device.deviceId, host.keys, 'm1'),
    }) as never)
    await arena.handle(guest.device.deviceId, frame('room.accept', {
      roomId: room.roomId, stake: stake(guest.device.deviceId, guest.keys, 'm2'),
    }) as never)
    const match = [...(arena.store as MemoryStore).matches.values()][0]!
    const eA = toHex(randomBytes(32))
    const eB = toHex(randomBytes(32))
    await arena.handle(host.device.deviceId, frame('match.entropy', {
      matchId: match.matchId,
      entropyHex: eA,
      signature: signEntropy(host.keys.ed25519PrivateKey, match.matchId, eA),
    }) as never)
    await arena.handle(guest.device.deviceId, frame('match.entropy', {
      matchId: match.matchId,
      entropyHex: eB,
      signature: signEntropy(guest.keys.ed25519PrivateKey, match.matchId, eB),
    }) as never)
    const engine = arena.engines.get(match.matchId)!
    expect(engine.state.toAct).toBe('A')
    await arena.handle(host.device.deviceId, frame('match.action', {
      matchId: match.matchId,
      handNo: engine.state.handNo,
      actionSeq: engine.state.actionSeq,
      action: 'fold',
      publicRationale: 'fold',
    }) as never)
    expect(engine.state.handNo).toBeGreaterThan(1)
    expect(engine.state.lastActions.length).toBeGreaterThanOrEqual(0)
    await arena.handle(host.device.deviceId, frame('session.heartbeat', { at: Date.now() }) as never)
    await arena.timeoutSeat(match.matchId, -1)
    await arena.timeoutSeat(match.matchId)
    await arena.evaluateDisconnect(match.matchId, Date.now() + 200_000)
  })

  it('sends grant.updated to both winner and owner after a finished match', async () => {
    const arena = service()
    const host = await register(arena)
    const guest = await register(arena)
    const inbox: Array<{ who: string; type: string }> = []
    arena.attach(host.device.deviceId, (f) => inbox.push({ who: 'h', type: f.type }))
    arena.attach(guest.device.deviceId, (f) => inbox.push({ who: 'g', type: f.type }))
    await arena.handle(host.device.deviceId, frame('room.create', { stake: stake(host.device.deviceId, host.keys, 'm1') }) as never)
    const room = [...(arena.store as MemoryStore).rooms.values()][0]!
    await arena.handle(guest.device.deviceId, frame('room.join', {
      roomCode: room.roomCode, stake: stake(guest.device.deviceId, guest.keys, 'm2'),
    }) as never)
    await arena.handle(host.device.deviceId, frame('room.accept', {
      roomId: room.roomId, stake: stake(host.device.deviceId, host.keys, 'm1'),
    }) as never)
    await arena.handle(guest.device.deviceId, frame('room.accept', {
      roomId: room.roomId, stake: stake(guest.device.deviceId, guest.keys, 'm2'),
    }) as never)
    const match = [...(arena.store as MemoryStore).matches.values()][0]!
    const eA = toHex(randomBytes(32))
    const eB = toHex(randomBytes(32))
    await arena.handle(host.device.deviceId, frame('match.entropy', {
      matchId: match.matchId, entropyHex: eA, signature: signEntropy(host.keys.ed25519PrivateKey, match.matchId, eA),
    }) as never)
    await arena.handle(guest.device.deviceId, frame('match.entropy', {
      matchId: match.matchId, entropyHex: eB, signature: signEntropy(guest.keys.ed25519PrivateKey, match.matchId, eB),
    }) as never)
    for (let i = 0; i < 40; i += 1) {
      const engine = arena.engines.get(match.matchId)
      if (!engine || engine.state.terminal) break
      const seat = engine.state.toAct
      if (!seat) break
      const deviceId = engine.state.players[seat].deviceId
      await arena.handle(deviceId, frame('match.action', {
        matchId: match.matchId,
        handNo: engine.state.handNo,
        actionSeq: engine.state.actionSeq,
        action: 'fold',
        publicRationale: 'fold',
      }) as never)
    }
    expect(inbox.filter((item) => item.type === 'grant.updated' && item.who === 'h').length).toBeGreaterThan(0)
    expect(inbox.filter((item) => item.type === 'grant.updated' && item.who === 'g').length).toBeGreaterThan(0)
    expect(inbox.some((item) => item.type === 'match.settled')).toBe(true)
  })

  it('forwards relay frames and rejects replays', async () => {
    const arena = service()
    const host = await register(arena)
    const guest = await register(arena)
    arena.attach(host.device.deviceId, () => undefined)
    arena.attach(guest.device.deviceId, () => undefined)
    const grantId = uuidv7()
    await arena.store.saveGrant({
      grantId, ownerDeviceId: guest.device.deviceId, winnerDeviceId: host.device.deviceId,
      model: 'm', provider: 'openai-compatible', callsRemaining: 2, activeConcurrency: 0,
      onlineMsRemaining: 1000, ownerOnline: true, status: 'active', statusReason: 'active',
      version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    const inferenceId = newInferenceId()
    await arena.handle(host.device.deviceId, frame('relay.reserve', {
      grantId, inferenceId, ciphertext: 'aa', nonce: 'bb',
      estimatedInputTokens: 1, requestBytes: 8, requestHash: 'h',
    }) as never)
    await arena.handle(guest.device.deviceId, frame('relay.preflight_ok', {
      grantId, inferenceId, requestHash: 'h',
    }) as never)
    await arena.handle(guest.device.deviceId, frame('relay.chunk', {
      grantId, inferenceId, seq: 1, ciphertext: 'cc', nonce: 'dd',
    }) as never)
    await arena.handle(host.device.deviceId, frame('relay.terminal', {
      grantId, inferenceId, status: 'cancelled',
    }) as never)
    const replay = frame('session.heartbeat', { at: 1 })
    await arena.handle(host.device.deviceId, replay as never)
    await expect(arena.handle(host.device.deviceId, replay as never)).rejects.toThrow(/REPLAY/)
  })

  it('aborts an in-flight owner stream when the winner socket closes', async () => {
    const arena = service()
    const winner = await register(arena)
    const owner = await register(arena)
    const ownerFrames: Array<{ type: string; payload: unknown }> = []
    const detachWinner = arena.attach(winner.device.deviceId, () => undefined)
    arena.attach(owner.device.deviceId, (frame) => { ownerFrames.push(frame) })
    const grantId = uuidv7()
    await arena.store.saveGrant({
      grantId, ownerDeviceId: owner.device.deviceId, winnerDeviceId: winner.device.deviceId,
      model: 'm', provider: 'openai-compatible', callsRemaining: 2, activeConcurrency: 0,
      onlineMsRemaining: 1000, ownerOnline: true, status: 'active', statusReason: 'active',
      version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    const inferenceId = newInferenceId()
    await arena.handle(winner.device.deviceId, frame('relay.reserve', {
      grantId, inferenceId, ciphertext: 'aa', nonce: 'bb',
      estimatedInputTokens: 1, requestBytes: 8, requestHash: 'h',
    }) as never)
    await arena.handle(owner.device.deviceId, frame('relay.preflight_ok', {
      grantId, inferenceId, requestHash: 'h',
    }) as never)
    expect((await arena.store.getGrant(grantId))?.callsRemaining).toBe(1)
    detachWinner()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ownerFrames.some((item) => item.type === 'relay.abort')).toBe(true)
    const inference = await arena.store.getInference(grantId, inferenceId)
    expect(inference?.status).toBe('aborted')
    expect(inference?.finishedAt).toBeTruthy()
    expect((await arena.store.getGrant(grantId))?.callsRemaining).toBe(1)
  })

  it('skips relay abort when the grant row is already gone', async () => {
    const arena = service()
    const winner = await register(arena)
    const owner = await register(arena)
    arena.attach(winner.device.deviceId, () => undefined)
    const missingGrantId = uuidv7()
    await arena.store.insertInference({
      grantId: missingGrantId,
      inferenceId: newInferenceId(),
      requesterDeviceId: winner.device.deviceId,
      ownerDeviceId: owner.device.deviceId,
      status: 'started',
      deducted: true,
      requestHash: 'h',
      startedAt: 1,
      finishedAt: null,
      terminalReason: null,
    })
    const reservedId = newInferenceId()
    const grantId = uuidv7()
    await arena.store.saveGrant({
      grantId, ownerDeviceId: owner.device.deviceId, winnerDeviceId: winner.device.deviceId,
      model: 'm', provider: 'openai-compatible', callsRemaining: 2, activeConcurrency: 0,
      onlineMsRemaining: 1000, ownerOnline: true, status: 'active', statusReason: 'active',
      version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    await arena.store.insertInference({
      grantId, inferenceId: reservedId, requesterDeviceId: winner.device.deviceId,
      ownerDeviceId: owner.device.deviceId, status: 'reserved', deducted: false,
      requestHash: 'h', startedAt: null, finishedAt: null, terminalReason: null,
    })
    await arena.handleDisconnect(winner.device.deviceId)
    expect((await arena.store.listOpenInferencesForRequester(winner.device.deviceId)).map((item) => item.grantId)).toEqual([missingGrantId])
    expect((await arena.store.getInference(grantId, reservedId))?.status).toBe('cancelled')
  })

  it('covers auth conflicts, room errors, disconnects and unhandled frames', async () => {
    const arena = service()
    const store = arena.store as MemoryStore
    const keys = generateDeviceKeypair()
    await store.putDevice({
      deviceId: uuidv7(),
      ed25519PublicKey: keys.ed25519PublicKey,
      x25519PublicKey: 'other',
      createdAt: 1,
      lastSeenAt: 1,
    })
    const conflict = arena.issueChallenge(keys.ed25519PublicKey, keys.x25519PublicKey, INVITE)
    await expect(arena.redeem({ nonce: conflict.nonce, signature: signUtf8(keys.ed25519PrivateKey, conflict.nonce) }))
      .rejects.toThrow(/IDENTITY_CONFLICT/)

    const returning = await register(arena)
    const again = arena.issueChallenge(returning.keys.ed25519PublicKey, returning.keys.x25519PublicKey)
    await expect(arena.redeem({
      nonce: again.nonce,
      signature: signUtf8(returning.keys.ed25519PrivateKey, again.nonce),
      deviceId: uuidv7(),
    })).rejects.toThrow(/IDENTITY_CONFLICT/)
    const okNonce = arena.issueChallenge(returning.keys.ed25519PublicKey, returning.keys.x25519PublicKey)
    await expect(arena.redeem({
      nonce: okNonce.nonce,
      signature: signUtf8(returning.keys.ed25519PrivateKey, okNonce.nonce),
    })).rejects.toThrow(/UNAUTHORIZED/)
    const signed = arena.issueChallenge(returning.keys.ed25519PublicKey, returning.keys.x25519PublicKey)
    const restored = await arena.redeem({
      nonce: signed.nonce,
      signature: signUtf8(returning.keys.ed25519PrivateKey, `agent-colosseum/device-v1\n${returning.device.deviceId}\n${signed.nonce}`),
      deviceId: returning.device.deviceId,
    })
    expect(restored.deviceId).toBe(returning.device.deviceId)
    const againOk = arena.issueChallenge(returning.keys.ed25519PublicKey, returning.keys.x25519PublicKey)
    const restoredNoId = await arena.redeem({
      nonce: againOk.nonce,
      signature: signUtf8(returning.keys.ed25519PrivateKey, `agent-colosseum/device-v1\n${returning.device.deviceId}\n${againOk.nonce}`),
    })
    expect(restoredNoId.deviceId).toBe(returning.device.deviceId)
    const invited = generateDeviceKeypair()
    const invitedCh = arena.issueChallenge(invited.ed25519PublicKey, invited.x25519PublicKey)
    const minted = await arena.redeem({
      nonce: invitedCh.nonce,
      signature: signUtf8(invited.ed25519PrivateKey, invitedCh.nonce),
      inviteCode: INVITE,
    })
    expect(minted.deviceId).toBeTruthy()

    const expired = arena.issueChallenge(keys.ed25519PublicKey, keys.x25519PublicKey, INVITE)
    arena.challenges.get(expired.nonce)!.expiresAt = 0
    await expect(arena.redeem({ nonce: expired.nonce, signature: '00' })).rejects.toThrow(/expired/)
    await expect(arena.redeem({ nonce: 'missing', signature: '00' })).rejects.toThrow(/expired/)

    const noInvite = generateDeviceKeypair()
    const bare = arena.issueChallenge(noInvite.ed25519PublicKey, noInvite.x25519PublicKey)
    await expect(arena.redeem({ nonce: bare.nonce, signature: signUtf8(noInvite.ed25519PrivateKey, bare.nonce) }))
      .rejects.toThrow(/INVITE/)

    const xKeys = generateDeviceKeypair()
    await store.putDevice({
      deviceId: uuidv7(), ed25519PublicKey: 'ee', x25519PublicKey: xKeys.x25519PublicKey, createdAt: 1, lastSeenAt: 1,
    })
    const xCh = arena.issueChallenge(xKeys.ed25519PublicKey, xKeys.x25519PublicKey, INVITE)
    await expect(arena.redeem({ nonce: xCh.nonce, signature: signUtf8(xKeys.ed25519PrivateKey, xCh.nonce) }))
      .rejects.toThrow(/IDENTITY_CONFLICT/)

    const badSig = generateDeviceKeypair()
    const badCh = arena.issueChallenge(badSig.ed25519PublicKey, badSig.x25519PublicKey, INVITE)
    await expect(arena.redeem({ nonce: badCh.nonce, signature: '00' })).rejects.toThrow(/UNAUTHORIZED/)

    const pending = generateDeviceKeypair()
    const pendingCh = arena.issueChallenge(pending.ed25519PublicKey, pending.x25519PublicKey, INVITE)
    const pendingDevice = await arena.redeem({
      nonce: pendingCh.nonce,
      signature: signUtf8(pending.ed25519PrivateKey, `agent-colosseum/device-v1\npending\n${pendingCh.nonce}`),
    })
    expect(pendingDevice.deviceId).toBeTruthy()

    const host = await register(arena)
    const guest = await register(arena)
    arena.attach(host.device.deviceId, () => undefined)
    arena.attach(guest.device.deviceId, () => undefined)
    await expect(arena.createRoom(host.device.deviceId, {
      ...stake(host.device.deviceId, host.keys, 'm1'),
      provider: 'deepseek-official',
    })).rejects.toThrow(/PROVIDER/)
    const forged = stake(guest.device.deviceId, host.keys, 'm1')
    await expect(arena.createRoom(host.device.deviceId, { ...forged, ownerDeviceId: host.device.deviceId }))
      .rejects.toThrow(/STAKE_SIGNATURE|UNAUTHORIZED/)
    await expect(arena.joinRoom(host.device.deviceId, 'NOPE00', stake(host.device.deviceId, host.keys, 'm1')))
      .rejects.toThrow(/unavailable/)
    const room = await arena.createRoom(host.device.deviceId, stake(host.device.deviceId, host.keys, 'm1'))
    await expect(arena.joinRoom(host.device.deviceId, room.roomCode, stake(host.device.deviceId, host.keys, 'm1')))
      .rejects.toThrow(/own room/)
    await expect(arena.acceptRoom(host.device.deviceId, room.roomId, stake(host.device.deviceId, host.keys, 'm1')))
      .rejects.toThrow(/not ready/)
    await arena.joinRoom(guest.device.deviceId, room.roomCode, stake(guest.device.deviceId, guest.keys, 'm2'))
    const stranger = await register(arena)
    await expect(arena.acceptRoom(stranger.device.deviceId, room.roomId, stake(stranger.device.deviceId, stranger.keys, 'm1')))
      .rejects.toThrow(/UNAUTHORIZED|STAKE/)
    await arena.leaveRoom(stranger.device.deviceId, room.roomId)
    await arena.leaveRoom(host.device.deviceId, room.roomId)
    await arena.leaveRoom(host.device.deviceId, uuidv7())
    await expect(arena.handle(host.device.deviceId, frame('auth.hello', {
      ed25519PublicKey: 'e', x25519PublicKey: 'x',
    }) as never)).rejects.toThrow(/UNHANDLED/)
    await arena.send(uuidv7(), 'noop', {})
    await arena.timeoutSeat(uuidv7())
    await arena.evaluateDisconnect(uuidv7())
    expect((await arena.listWinnerGrants(host.device.deviceId)).length).toBe(0)
    await arena.store.saveGrant({
      grantId: uuidv7(), ownerDeviceId: guest.device.deviceId, winnerDeviceId: host.device.deviceId,
      model: 'm', provider: 'openai-compatible', callsRemaining: 1, activeConcurrency: 0,
      onlineMsRemaining: 5, ownerOnline: false, status: 'active', statusReason: 'active',
      version: 1, stakeId: 's', lastOnlineTickAt: null,
    })
    expect((await arena.listWinnerGrants(host.device.deviceId)).length).toBe(1)
  })

  it('forfeits after disconnect grace and double-disconnects', async () => {
    const arena = service()
    const host = await register(arena)
    const guest = await register(arena)
    arena.attach(host.device.deviceId, () => undefined)
    arena.attach(guest.device.deviceId, () => undefined)
    await arena.handle(host.device.deviceId, frame('room.create', { stake: stake(host.device.deviceId, host.keys, 'm1') }) as never)
    const room = [...(arena.store as MemoryStore).rooms.values()][0]!
    await arena.handle(guest.device.deviceId, frame('room.join', {
      roomCode: room.roomCode, stake: stake(guest.device.deviceId, guest.keys, 'm2'),
    }) as never)
    await arena.handle(host.device.deviceId, frame('room.accept', {
      roomId: room.roomId, stake: stake(host.device.deviceId, host.keys, 'm1'),
    }) as never)
    await arena.handle(guest.device.deviceId, frame('room.accept', {
      roomId: room.roomId, stake: stake(guest.device.deviceId, guest.keys, 'm2'),
    }) as never)
    const match = [...(arena.store as MemoryStore).matches.values()][0]!
    const eA = toHex(randomBytes(32))
    const eB = toHex(randomBytes(32))
    await arena.handle(host.device.deviceId, frame('match.entropy', {
      matchId: match.matchId, entropyHex: eA, signature: signEntropy(host.keys.ed25519PrivateKey, match.matchId, eA),
    }) as never)
    await arena.handle(guest.device.deviceId, frame('match.entropy', {
      matchId: match.matchId, entropyHex: eB, signature: signEntropy(guest.keys.ed25519PrivateKey, match.matchId, eB),
    }) as never)
    await expect(arena.handle(host.device.deviceId, frame('match.action', {
      matchId: match.matchId, handNo: 1, actionSeq: 99, action: 'fold', publicRationale: 'x',
    }) as never)).rejects.toThrow(/STALE/)
    await arena.leaveRoom(host.device.deviceId, room.roomId)
    await arena.handleDisconnect(uuidv7())
    await arena.handleDisconnect(host.device.deviceId, Date.now() + 20_000)
    await arena.evaluateDisconnect(match.matchId, Date.now() + 20_000)
    arena.presence.disconnect(host.device.deviceId)
    arena.presence.disconnect(guest.device.deviceId)
    await arena.evaluateDisconnect(match.matchId, Date.now() + 200_000)
    const second = service()
    const h2 = await register(second)
    const g2 = await register(second)
    second.attach(h2.device.deviceId, () => undefined)
    second.attach(g2.device.deviceId, () => undefined)
    await second.handle(h2.device.deviceId, frame('room.create', { stake: stake(h2.device.deviceId, h2.keys, 'm1') }) as never)
    const room2 = [...(second.store as MemoryStore).rooms.values()][0]!
    await second.handle(g2.device.deviceId, frame('room.join', {
      roomCode: room2.roomCode, stake: stake(g2.device.deviceId, g2.keys, 'm2'),
    }) as never)
    await second.handle(h2.device.deviceId, frame('room.accept', {
      roomId: room2.roomId, stake: stake(h2.device.deviceId, h2.keys, 'm1'),
    }) as never)
    await second.handle(g2.device.deviceId, frame('room.accept', {
      roomId: room2.roomId, stake: stake(g2.device.deviceId, g2.keys, 'm2'),
    }) as never)
    const match2 = [...(second.store as MemoryStore).matches.values()][0]!
    const a2 = toHex(randomBytes(32))
    const b2 = toHex(randomBytes(32))
    await second.handle(h2.device.deviceId, frame('match.entropy', {
      matchId: match2.matchId, entropyHex: a2, signature: signEntropy(h2.keys.ed25519PrivateKey, match2.matchId, a2),
    }) as never)
    await second.handle(g2.device.deviceId, frame('match.entropy', {
      matchId: match2.matchId, entropyHex: b2, signature: signEntropy(g2.keys.ed25519PrivateKey, match2.matchId, b2),
    }) as never)
    const later = Date.now() + 200_000
    second.presence.beat(g2.device.deviceId, later)
    second.presence.disconnect(h2.device.deviceId)
    await second.handleDisconnect(h2.device.deviceId, later)
    expect(second.engines.get(match2.matchId)?.state.terminal?.reason).toBe('forfeit')

    const third = service()
    const h3 = await register(third)
    const g3 = await register(third)
    third.attach(h3.device.deviceId, () => undefined)
    third.attach(g3.device.deviceId, () => undefined)
    await third.handle(h3.device.deviceId, frame('room.create', { stake: stake(h3.device.deviceId, h3.keys, 'm1') }) as never)
    const room3 = [...(third.store as MemoryStore).rooms.values()][0]!
    await third.handle(g3.device.deviceId, frame('room.join', {
      roomCode: room3.roomCode, stake: stake(g3.device.deviceId, g3.keys, 'm2'),
    }) as never)
    await third.handle(h3.device.deviceId, frame('room.accept', {
      roomId: room3.roomId, stake: stake(h3.device.deviceId, h3.keys, 'm1'),
    }) as never)
    await third.handle(g3.device.deviceId, frame('room.accept', {
      roomId: room3.roomId, stake: stake(g3.device.deviceId, g3.keys, 'm2'),
    }) as never)
    const match3 = [...(third.store as MemoryStore).matches.values()][0]!
    const a3 = toHex(randomBytes(32))
    const b3 = toHex(randomBytes(32))
    await third.handle(h3.device.deviceId, frame('match.entropy', {
      matchId: match3.matchId, entropyHex: a3, signature: signEntropy(h3.keys.ed25519PrivateKey, match3.matchId, a3),
    }) as never)
    await third.handle(g3.device.deviceId, frame('match.entropy', {
      matchId: match3.matchId, entropyHex: b3, signature: signEntropy(g3.keys.ed25519PrivateKey, match3.matchId, b3),
    }) as never)
    await third.timeoutSeat(match3.matchId)
    const later3 = Date.now() + 200_000
    third.presence.beat(h3.device.deviceId, later3)
    third.presence.disconnect(g3.device.deviceId)
    await third.evaluateDisconnect(match3.matchId, later3)
    expect(third.engines.get(match3.matchId)?.state.terminal?.reason).toBe('forfeit')
  })
})
