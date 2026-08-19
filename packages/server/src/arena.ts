import {
  commitServerSeed,
  deriveHandDeck,
  genesisHash,
  nextEventHash,
  verifyEntropy,
  verifyStake,
} from '@agent-colosseum/crypto'
import { PokerEngine } from '@agent-colosseum/poker'
import {
  DISCONNECT_FORFEIT_MS,
  newMatchId,
  newMessageId,
  newRoomCode,
  newRoomId,
  newStakeId,
  PROTOCOL_VERSION,
  stakeTermsFingerprint,
  type KnownClientFrame,
  type PokerActionV1,
  type StakeSpecV1,
} from '@agent-colosseum/protocol'
import { issueChallenge, redeemDevice, type AuthChallenge } from './auth.ts'
import { isProviderAllowed, type ServerConfig } from './config.ts'
import { MemoryPresence, type PresenceBook } from './presence.ts'
import { RelayController } from './relay.ts'
import { settleMatch, tickGrantOnline } from './settlement.ts'
import type { ArenaStore, DeviceRecord, MatchRecord, RoomRecord } from './store.ts'

export type Outbound = { type: string; payload: unknown }

export class ArenaService {
  readonly presence: PresenceBook
  readonly relay: RelayController
  readonly sockets = new Map<string, Set<(frame: Outbound) => void>>()
  readonly seen = new Map<string, Set<string>>()
  readonly engines = new Map<string, PokerEngine>()
  readonly challenges = new Map<string, AuthChallenge>()
  private eventHash = new Map<string, string>()

  constructor(
    readonly store: ArenaStore,
    readonly config: ServerConfig,
    presence?: PresenceBook,
  ) {
    this.presence = presence ?? new MemoryPresence()
    this.relay = new RelayController(store)
  }

  issueChallenge(ed25519: string, x25519: string, inviteCode?: string) {
    return issueChallenge(this.challenges, ed25519, x25519, inviteCode)
  }

  async redeem(input: {
    nonce: string
    signature: string
    inviteCode?: string
    deviceId?: string
  }): Promise<DeviceRecord> {
    return redeemDevice(this.store, this.challenges, input)
  }

  attach(deviceId: string, send: (frame: Outbound) => void): () => void {
    const set = this.sockets.get(deviceId) ?? new Set()
    set.add(send)
    this.sockets.set(deviceId, set)
    this.presence.connect(deviceId)
    return () => {
      set.delete(send)
      if (set.size === 0) this.sockets.delete(deviceId)
      void this.handleDisconnect(deviceId)
    }
  }

  send(deviceId: string, type: string, payload: unknown): void {
    const frame = { type, payload }
    for (const sink of this.sockets.get(deviceId) ?? []) sink(frame)
  }

  broadcast(deviceIds: string[], type: string, payload: unknown): void {
    for (const id of new Set(deviceIds)) this.send(id, type, payload)
  }

  remember(deviceId: string, messageId: string): void {
    const set = this.seen.get(deviceId) ?? new Set()
    if (set.has(messageId)) throw new Error('REPLAY')
    set.add(messageId)
    this.seen.set(deviceId, set)
  }

  async handle(deviceId: string, frame: KnownClientFrame): Promise<void> {
    this.remember(deviceId, frame.messageId)
    this.presence.beat(deviceId)
    switch (frame.type) {
      case 'session.heartbeat':
        return
      case 'room.create': {
        const room = await this.createRoom(deviceId, frame.payload.stake)
        this.send(deviceId, 'room.created', room)
        return
      }
      case 'room.join': {
        const room = await this.joinRoom(deviceId, frame.payload.roomCode, frame.payload.stake)
        this.broadcast([room.hostDeviceId, room.guestDeviceId!], 'room.updated', room)
        return
      }
      case 'room.accept': {
        const room = await this.acceptRoom(deviceId, frame.payload.roomId, frame.payload.stake)
        this.broadcast([room.hostDeviceId, room.guestDeviceId!], 'room.updated', room)
        return
      }
      case 'room.leave':
        await this.leaveRoom(deviceId, frame.payload.roomId)
        return
      case 'match.entropy':
        await this.submitEntropy(deviceId, frame.payload.matchId, frame.payload.entropyHex, frame.payload.signature)
        return
      case 'match.action':
        await this.submitAction(deviceId, frame.payload)
        return
      case 'relay.reserve':
        await this.forwardReserve(deviceId, frame.payload)
        return
      case 'relay.preflight_ok':
        await this.forwardPreflight(deviceId, frame.payload)
        return
      case 'relay.chunk':
        await this.forwardRelayChunk(deviceId, frame.payload)
        return
      case 'relay.terminal':
        await this.forwardRelayTerminal(deviceId, frame.payload)
        return
      default:
        throw new Error('UNHANDLED')
    }
  }

  assertStake(deviceId: string, stake: StakeSpecV1, publicKey: string): void {
    if (!isProviderAllowed(this.config.providerAllowlist, stake.provider)) throw new Error('PROVIDER_DENIED')
    if (stake.ownerDeviceId !== deviceId) throw new Error('UNAUTHORIZED')
    if (!verifyStake(publicKey, stake)) throw new Error('STAKE_SIGNATURE')
  }

  async createRoom(hostDeviceId: string, stake: StakeSpecV1): Promise<RoomRecord> {
    const device = (await this.store.getDevice(hostDeviceId))!
    this.assertStake(hostDeviceId, stake, device.ed25519PublicKey)
    const room: RoomRecord = {
      roomId: newRoomId(),
      roomCode: newRoomCode(),
      hostDeviceId,
      guestDeviceId: null,
      hostStake: stake,
      guestStake: null,
      hostAccepted: false,
      guestAccepted: false,
      matchId: null,
      status: 'open',
    }
    await this.store.putRoom(room)
    return room
  }

  async joinRoom(guestDeviceId: string, roomCode: string, stake: StakeSpecV1): Promise<RoomRecord> {
    const device = (await this.store.getDevice(guestDeviceId))!
    this.assertStake(guestDeviceId, stake, device.ed25519PublicKey)
    const room = await this.store.findRoomByCode(roomCode)
    if (!room || room.status !== 'open') throw new Error('room unavailable')
    if (room.hostDeviceId === guestDeviceId) throw new Error('cannot join own room')
    if (stakeTermsFingerprint(stake) !== stakeTermsFingerprint(room.hostStake)) throw new Error('STAKE_MISMATCH')
    return this.store.updateRoom(room.roomId, { guestDeviceId, guestStake: stake })
  }

  async acceptRoom(deviceId: string, roomId: string, stake: StakeSpecV1): Promise<RoomRecord> {
    const room = await this.store.getRoom(roomId)
    if (!room || !room.guestDeviceId || !room.guestStake) throw new Error('room not ready')
    if (stakeTermsFingerprint(stake) !== stakeTermsFingerprint(room.hostStake)) throw new Error('STAKE_MISMATCH')
    const patch: Partial<RoomRecord> = {}
    if (deviceId === room.hostDeviceId) patch.hostAccepted = true
    else if (deviceId === room.guestDeviceId) patch.guestAccepted = true
    else throw new Error('UNAUTHORIZED')
    const next = await this.store.updateRoom(roomId, patch)
    if (next.hostAccepted && next.guestAccepted && !next.matchId) await this.openMatch(next)
    return (await this.store.getRoom(roomId))!
  }

  async leaveRoom(deviceId: string, roomId: string): Promise<void> {
    const room = await this.store.getRoom(roomId)
    if (!room || room.matchId) return
    if (deviceId === room.hostDeviceId || deviceId === room.guestDeviceId) {
      await this.store.updateRoom(roomId, { status: 'closed' })
    }
  }

  async submitEntropy(deviceId: string, matchId: string, entropyHex: string, signature: string): Promise<void> {
    const match = await this.store.getMatch(matchId)
    const device = await this.store.getDevice(deviceId)
    if (!match || !device || match.status !== 'pending_entropy') throw new Error('no pending match')
    if (!verifyEntropy(device.ed25519PublicKey, matchId, entropyHex, signature)) throw new Error('UNAUTHORIZED')
    const patch: Partial<MatchRecord> = {}
    if (deviceId === match.deviceA) patch.entropyA = entropyHex
    else if (deviceId === match.deviceB) patch.entropyB = entropyHex
    else throw new Error('UNAUTHORIZED')
    await this.store.saveMatchState(matchId, patch)
    const next = (await this.store.getMatch(matchId))!
    if (next.entropyA && next.entropyB) await this.dealFirst(next)
  }

  async submitAction(deviceId: string, action: PokerActionV1): Promise<void> {
    const engine = this.engines.get(action.matchId)
    const match = await this.store.getMatch(action.matchId)
    if (!engine || !match || match.status !== 'live') throw new Error('no live match')
    if (action.handNo !== engine.state.handNo || action.actionSeq !== engine.state.actionSeq) throw new Error('STALE_ACTION')
    const seat = engine.seatOf(deviceId)
    if (!engine.legalActions().some((item) => item.action === action.action)) throw new Error('ILLEGAL_ACTION')
    engine.apply(seat, action.action, action.raiseTo, action.publicRationale)
    await this.persistAndPublish(engine)
  }

  async timeoutSeat(matchId: string): Promise<void> {
    const engine = this.engines.get(matchId)
    const match = await this.store.getMatch(matchId)
    if (!engine || !match || match.status !== 'live' || !engine.state.toAct) return
    engine.autoFault(engine.state.toAct)
    await this.persistAndPublish(engine)
  }

  async handleDisconnect(deviceId: string, now = Date.now()): Promise<void> {
    this.presence.disconnect(deviceId)
    for (const engine of this.engines.values()) {
      if (engine.state.terminal) continue
      const ids = [engine.state.players.A.deviceId, engine.state.players.B.deviceId]
      if (!ids.includes(deviceId)) continue
      const other = ids.find((id) => id !== deviceId)!
      const selfOff = this.presence.offlineSince(deviceId, now)
      const otherOff = this.presence.offlineSince(other, now)
      if (selfOff !== null && otherOff !== null) {
        engine.doubleDisconnect()
        await this.finish(engine)
      } else if (selfOff !== null && selfOff > DISCONNECT_FORFEIT_MS) {
        engine.forfeit(engine.seatOf(deviceId))
        await this.finish(engine)
      }
    }
  }

  async evaluateDisconnect(matchId: string, now = Date.now()): Promise<void> {
    const engine = this.engines.get(matchId)
    if (!engine || engine.state.terminal) return
    const a = engine.state.players.A.deviceId
    const b = engine.state.players.B.deviceId
    const aOff = this.presence.offlineSince(a, now)
    const bOff = this.presence.offlineSince(b, now)
    if (aOff !== null && bOff !== null) {
      engine.doubleDisconnect()
      await this.finish(engine)
      return
    }
    if (aOff !== null && aOff > DISCONNECT_FORFEIT_MS) {
      engine.forfeit('A')
      await this.finish(engine)
    } else if (bOff !== null && bOff > DISCONNECT_FORFEIT_MS) {
      engine.forfeit('B')
      await this.finish(engine)
    }
  }

  async listWinnerGrants(deviceId: string) {
    const grants = await this.store.listGrantsForWinner(deviceId)
    const ticked = []
    for (const grant of grants) {
      ticked.push(await tickGrantOnline(this.store, grant, this.presence.isOnline(grant.ownerDeviceId)))
    }
    return ticked
  }

  async restoreLive(): Promise<void> {
    for (const match of await this.store.listLiveMatches()) {
      if (match.state) this.engines.set(match.matchId, PokerEngine.fromState(match.state))
    }
  }

  private async openMatch(room: RoomRecord): Promise<void> {
    const commit = commitServerSeed()
    const matchId = newMatchId()
    const record: MatchRecord = {
      matchId,
      roomId: room.roomId,
      deviceA: room.hostDeviceId,
      deviceB: room.guestDeviceId!,
      commitment: commit.commitment,
      serverSeedHex: commit.serverSeedHex,
      entropyA: null,
      entropyB: null,
      status: 'pending_entropy',
      winnerDeviceId: null,
      settled: false,
      state: null,
      createdAt: Date.now(),
    }
    await this.store.putMatch(record)
    await this.store.putStake({ stakeId: newStakeId(), matchId, spec: room.hostStake, status: 'locked' })
    await this.store.putStake({ stakeId: newStakeId(), matchId, spec: room.guestStake!, status: 'locked' })
    await this.store.updateRoom(room.roomId, { matchId, status: 'matched' })
    this.eventHash.set(matchId, genesisHash())
    await this.recordEvent(matchId, { type: 'match.open', commitment: commit.commitment })
    this.broadcast([record.deviceA, record.deviceB], 'match.proposal', {
      matchId,
      commitment: commit.commitment,
      hostStake: room.hostStake,
      guestStake: room.guestStake,
    })
  }

  private async dealFirst(match: MatchRecord): Promise<void> {
    const deck = deriveHandDeck({
      matchId: match.matchId,
      handNo: 1,
      serverSeedHex: match.serverSeedHex,
      playerEntropy: [match.entropyA!, match.entropyB!],
    })
    const engine = PokerEngine.create({
      matchId: match.matchId,
      deviceA: match.deviceA,
      deviceB: match.deviceB,
      deck,
    })
    engine.startHand(deck)
    this.engines.set(match.matchId, engine)
    await this.store.saveMatchState(match.matchId, { status: 'live', state: engine.toState() })
    await this.publishSnapshots(engine)
  }

  private async persistAndPublish(engine: PokerEngine): Promise<void> {
    if (engine.state.street === 'complete' && !engine.state.terminal) {
      const terminal = engine.maybeFinishMatch()
      if (!terminal) {
        const match = (await this.store.getMatch(engine.state.matchId))!
        const deck = deriveHandDeck({
          matchId: match.matchId,
          handNo: engine.state.handNo + 1,
          serverSeedHex: match.serverSeedHex,
          playerEntropy: [match.entropyA!, match.entropyB!],
        })
        engine.startHand(deck)
      }
    }
    await this.store.saveMatchState(engine.state.matchId, {
      state: engine.toState(),
      status: engine.state.terminal ? 'terminal' : 'live',
    })
    await this.recordEvent(engine.state.matchId, { type: 'state', actionSeq: engine.state.actionSeq })
    await this.publishSnapshots(engine)
    if (engine.state.terminal) await this.finish(engine)
  }

  private async publishSnapshots(engine: PokerEngine): Promise<void> {
    for (const seat of ['A', 'B'] as const) {
      this.send(engine.state.players[seat].deviceId, 'match.private', engine.snapshot(seat))
    }
    this.broadcast(
      [engine.state.players.A.deviceId, engine.state.players.B.deviceId],
      'match.public',
      engine.snapshot(),
    )
    if (engine.state.toAct) {
      const seat = engine.state.toAct
      this.send(engine.state.players[seat].deviceId, 'match.action_request', {
        handNo: engine.state.handNo,
        actionSeq: engine.state.actionSeq,
        legal: engine.legalActions(),
        deadlineAt: Date.now() + 60_000,
      })
    }
  }

  private async finish(engine: PokerEngine): Promise<void> {
    const terminal = engine.state.terminal
    if (!terminal) return
    const grant = await settleMatch(this.store, {
      matchId: engine.state.matchId,
      winnerDeviceId: terminal.winnerDeviceId,
      reason: terminal.reason,
    })
    const match = (await this.store.getMatch(engine.state.matchId))!
    await this.recordEvent(engine.state.matchId, {
      type: 'match.end',
      terminal,
      serverSeedHex: match.serverSeedHex,
      grantId: grant?.grantId ?? null,
    })
    this.broadcast(
      [engine.state.players.A.deviceId, engine.state.players.B.deviceId],
      'match.settled',
      { terminal, grant, serverSeedHex: match.serverSeedHex },
    )
    if (grant) {
      const owner = await this.store.getDevice(grant.ownerDeviceId)
      this.send(grant.winnerDeviceId, 'grant.updated', {
        ...grant,
        ownerX25519PublicKey: owner?.x25519PublicKey,
      })
    }
  }

  private async forwardReserve(winnerId: string, payload: {
    grantId: string
    inferenceId: string
    ciphertext: string
    nonce: string
    estimatedInputTokens: number
    requestBytes: number
    requestHash: string
  }): Promise<void> {
    const reserved = await this.relay.reserve({
      grantId: payload.grantId,
      inferenceId: payload.inferenceId,
      winnerDeviceId: winnerId,
      requestBytes: payload.requestBytes,
      requestHash: payload.requestHash,
      ownerOnline: this.presence.isOnline((await this.store.getGrant(payload.grantId))!.ownerDeviceId),
    })
    const winner = await this.store.getDevice(winnerId)
    this.send(reserved.grant.ownerDeviceId, 'relay.reserve', {
      ...payload,
      winnerDeviceId: winnerId,
      winnerX25519PublicKey: winner?.x25519PublicKey,
    })
    this.send(winnerId, 'relay.reserved', { inferenceId: payload.inferenceId, created: reserved.created })
  }

  private async forwardPreflight(ownerId: string, payload: {
    grantId: string
    inferenceId: string
    requestHash: string
  }): Promise<void> {
    const grant = await this.store.getGrant(payload.grantId)
    if (!grant || grant.ownerDeviceId !== ownerId) throw new Error('UNAUTHORIZED')
    await this.relay.preflight(payload.grantId, payload.inferenceId, payload.requestHash)
    const started = await this.relay.start(payload.grantId, payload.inferenceId)
    this.send(grant.winnerDeviceId, 'relay.inference_started', { grantId: payload.grantId, inferenceId: payload.inferenceId })
    this.send(ownerId, 'relay.inference_started', { grantId: payload.grantId, inferenceId: payload.inferenceId })
    this.send(grant.winnerDeviceId, 'grant.updated', started)
  }

  private async forwardRelayChunk(fromId: string, payload: {
    grantId: string
    inferenceId: string
    seq: number
    ciphertext: string
    nonce: string
  }): Promise<void> {
    const grant = await this.store.getGrant(payload.grantId)
    if (!grant) throw new Error('GRANT_UNAVAILABLE')
    const dest = fromId === grant.ownerDeviceId ? grant.winnerDeviceId : grant.ownerDeviceId
    this.send(dest, 'relay.chunk', payload)
  }

  private async forwardRelayTerminal(fromId: string, payload: {
    grantId: string
    inferenceId: string
    status: 'completed' | 'cancelled' | 'owner_offline' | 'provider_error' | 'aborted'
  }): Promise<void> {
    const mapped = payload.status === 'owner_offline' ? 'aborted' as const : payload.status
    const { grant } = await this.relay.terminal(payload.grantId, payload.inferenceId, mapped)
    const dest = fromId === grant.ownerDeviceId ? grant.winnerDeviceId : grant.ownerDeviceId
    this.send(dest, 'relay.terminal', payload)
    if (fromId === grant.winnerDeviceId && (mapped === 'cancelled' || mapped === 'aborted')) {
      this.send(grant.ownerDeviceId, 'relay.abort', { grantId: payload.grantId, inferenceId: payload.inferenceId })
    }
  }

  private async recordEvent(matchId: string, payload: unknown): Promise<void> {
    const prev = this.eventHash.get(matchId) ?? genesisHash()
    const hash = nextEventHash(prev, payload)
    const existing = await this.store.listEvents(matchId)
    await this.store.appendEvent(matchId, existing.length, hash, payload)
    this.eventHash.set(matchId, hash)
  }
}

export function serverFrame(type: string, payload: unknown) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: newMessageId(),
    sentAt: Date.now(),
    type,
    payload,
  }
}
