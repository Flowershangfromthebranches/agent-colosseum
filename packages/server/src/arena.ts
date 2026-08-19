import {
  commitServerSeed,
  deriveHandDeck,
  genesisHash,
  nextEventHash,
  randomBytes,
  toHex,
  verifyChallenge,
} from '@agent-colosseum/crypto'
import { PokerEngine } from '@agent-colosseum/poker'
import {
  DISCONNECT_FORFEIT_MS,
  defaultStakeSpec,
  newMatchId,
  newRoomCode,
  newRoomId,
  newStakeId,
  stakeFingerprint,
  type PokerAction,
  type StakeSpec,
} from '@agent-colosseum/protocol'
import { isProviderAllowed, type ServerConfig } from './config.ts'
import { PresenceBook } from './presence.ts'
import { RelayController } from './relay.ts'
import { settleMatch, tickGrantOnline } from './settlement.ts'
import type { ArenaStore, DeviceRecord, MatchRecord, RoomRecord } from './store.ts'

export class ArenaService {
  readonly presence = new PresenceBook()
  readonly relay: RelayController
  readonly engines = new Map<string, PokerEngine>()
  readonly sessions = new Map<string, { deviceId: string; expiresAt: number }>()
  readonly challenges = new Map<string, { nonce: string; expiresAt: number; ed25519PublicKey: string; x25519PublicKey: string }>()
  private eventHash = new Map<string, string>()

  constructor(
    readonly store: ArenaStore,
    readonly config: ServerConfig,
  ) {
    this.relay = new RelayController(store)
  }

  issueChallenge(ed25519PublicKey: string, x25519PublicKey: string): { nonce: string; expiresAt: number } {
    const nonce = toHex(randomBytes(24))
    const expiresAt = Date.now() + 30_000
    this.challenges.set(nonce, { nonce, expiresAt, ed25519PublicKey, x25519PublicKey })
    return { nonce, expiresAt }
  }

  async redeemChallenge(input: {
    nonce: string
    signature: string
    inviteCode?: string
    deviceId?: string
  }): Promise<DeviceRecord> {
    const challenge = this.challenges.get(input.nonce)
    this.challenges.delete(input.nonce)
    if (!challenge || challenge.expiresAt < Date.now()) throw new Error('challenge expired')
    if (!verifyChallenge(challenge.ed25519PublicKey, input.nonce, input.signature)) {
      throw new Error('bad signature')
    }
    const existing = await this.store.findDeviceByPubkey(challenge.ed25519PublicKey)
    if (existing) {
      await this.store.touchDevice(existing.deviceId, Date.now())
      return existing
    }
    if (!input.inviteCode || !this.config.inviteCodes.includes(input.inviteCode)) {
      throw new Error('invite required')
    }
    if (!input.deviceId) throw new Error('deviceId required on first register')
    const device: DeviceRecord = {
      deviceId: input.deviceId,
      ed25519PublicKey: challenge.ed25519PublicKey,
      x25519PublicKey: challenge.x25519PublicKey,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    await this.store.putDevice(device)
    return device
  }

  assertStakeAllowed(stake: StakeSpec): void {
    if (!isProviderAllowed(this.config.providerAllowlist, stake.provider)) {
      throw new Error(`provider ${stake.provider} is not allowlisted for real grants`)
    }
    const expected = defaultStakeSpec(stake.ownerDeviceId, stake.provider, stake.model, stake.signature)
    if (stakeFingerprint(stake) !== stakeFingerprint(expected)) {
      throw new Error('unsupported stake spec')
    }
  }

  async createRoom(hostDeviceId: string, stake: StakeSpec): Promise<RoomRecord> {
    this.assertStakeAllowed(stake)
    if (stake.ownerDeviceId !== hostDeviceId) throw new Error('stake owner mismatch')
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

  async joinRoom(guestDeviceId: string, roomCode: string, stake: StakeSpec): Promise<RoomRecord> {
    this.assertStakeAllowed(stake)
    if (stake.ownerDeviceId !== guestDeviceId) throw new Error('stake owner mismatch')
    const room = await this.store.findRoomByCode(roomCode)
    if (!room || room.status !== 'open') throw new Error('room unavailable')
    if (room.hostDeviceId === guestDeviceId) throw new Error('cannot join own room')
    if (stakeFingerprint(stake) !== stakeFingerprint(room.hostStake)) throw new Error('stake mismatch')
    return this.store.updateRoom(room.roomId, {
      guestDeviceId,
      guestStake: stake,
    })
  }

  async acceptRoom(deviceId: string, roomId: string): Promise<RoomRecord> {
    const room = await this.store.getRoom(roomId)
    if (!room || !room.guestDeviceId || !room.guestStake) throw new Error('room not ready')
    const patch: Partial<RoomRecord> = {}
    if (deviceId === room.hostDeviceId) patch.hostAccepted = true
    else if (deviceId === room.guestDeviceId) patch.guestAccepted = true
    else throw new Error('not in room')
    const next = await this.store.updateRoom(roomId, patch)
    if (next.hostAccepted && next.guestAccepted && !next.matchId) {
      await this.startMatch(next)
      return (await this.store.getRoom(roomId))!
    }
    return next
  }

  async leaveRoom(deviceId: string, roomId: string): Promise<void> {
    const room = await this.store.getRoom(roomId)
    if (!room) return
    if (room.matchId) return
    if (deviceId === room.hostDeviceId || deviceId === room.guestDeviceId) {
      await this.store.updateRoom(roomId, { status: 'closed' })
    }
  }

  async submitAction(deviceId: string, action: PokerAction): Promise<PokerEngine> {
    const engine = this.engines.get(action.matchId)
    const match = await this.store.getMatch(action.matchId)
    if (!engine || !match || match.status !== 'live') throw new Error('no live match')
    if (action.handNo !== engine.handNo || action.actionSeq !== engine.actionSeq) {
      throw new Error('stale action')
    }
    const seat = engine.seatOf(deviceId)
    const legal = engine.legalActions()
    if (!legal.some((item) => item.action === action.action)) throw new Error('illegal action')
    engine.apply(seat, action.action, action.raiseTo, action.publicRationale)
    await this.recordEvent(engine.matchId, { type: 'action', action })
    await this.afterEngine(engine)
    return engine
  }

  async timeoutSeat(matchId: string): Promise<void> {
    const engine = this.engines.get(matchId)
    if (!engine || !engine.toAct) return
    engine.autoFault(engine.toAct)
    await this.recordEvent(engine.matchId, { type: 'timeout', seat: engine.toAct })
    await this.afterEngine(engine)
  }

  async handleDisconnect(deviceId: string, now = Date.now()): Promise<void> {
    this.presence.disconnect(deviceId)
    for (const engine of this.engines.values()) {
      if (engine.terminal) continue
      const ids = [engine.buttonDeviceId, engine.bbDeviceId]
      if (!ids.includes(deviceId)) continue
      const other = ids.find((id) => id !== deviceId)!
      const selfOffline = this.presence.offlineSince(deviceId, now)
      const otherOffline = this.presence.offlineSince(other, now)
      if (selfOffline !== null && otherOffline !== null) {
        engine.doubleDisconnect()
        await this.finish(engine)
        continue
      }
      if (selfOffline !== null && selfOffline > DISCONNECT_FORFEIT_MS) {
        engine.forfeit(engine.seatOf(deviceId))
        await this.finish(engine)
      }
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

  private async startMatch(room: RoomRecord): Promise<void> {
    const commit = commitServerSeed()
    const entropy: [string, string] = [toHex(randomBytes(32)), toHex(randomBytes(32))]
    const matchId = newMatchId()
    const buttonDeviceId = room.hostDeviceId
    const bbDeviceId = room.guestDeviceId!
    const record: MatchRecord = {
      matchId,
      roomId: room.roomId,
      buttonDeviceId,
      bbDeviceId,
      serverSeedHex: commit.serverSeedHex,
      commitment: commit.commitment,
      playerEntropy: entropy,
      status: 'live',
      winnerDeviceId: null,
      settled: false,
      createdAt: Date.now(),
    }
    await this.store.putMatch(record)
    await this.store.putStake({
      stakeId: newStakeId(),
      matchId,
      spec: room.hostStake,
      status: 'locked',
    })
    await this.store.putStake({
      stakeId: newStakeId(),
      matchId,
      spec: room.guestStake!,
      status: 'locked',
    })
    await this.store.updateRoom(room.roomId, { matchId, status: 'matched' })
    const engine = new PokerEngine({ matchId, buttonDeviceId, bbDeviceId })
    this.engines.set(matchId, engine)
    this.eventHash.set(matchId, genesisHash())
    await this.recordEvent(matchId, {
      type: 'match.start',
      commitment: commit.commitment,
      entropy,
    })
    await this.dealNext(engine, record)
  }

  private async dealNext(engine: PokerEngine, match: MatchRecord): Promise<void> {
    const deck = deriveHandDeck({
      matchId: match.matchId,
      handNo: engine.handNo + 1,
      serverSeedHex: match.serverSeedHex,
      playerEntropy: match.playerEntropy,
    })
    engine.startHand(deck)
    await this.recordEvent(match.matchId, { type: 'hand.start', handNo: engine.handNo })
    await this.afterEngine(engine)
  }

  private async afterEngine(engine: PokerEngine): Promise<void> {
    if (engine.street === 'complete' && !engine.terminal) {
      const terminal = engine.maybeFinishMatch()
      if (!terminal) {
        const match = (await this.store.getMatch(engine.matchId))!
        await this.dealNext(engine, match)
        return
      }
    }
    if (engine.terminal) await this.finish(engine)
  }

  private async finish(engine: PokerEngine): Promise<void> {
    const terminal = engine.terminal
    if (!terminal) return
    const grant = await settleMatch(this.store, {
      matchId: engine.matchId,
      winnerDeviceId: terminal.winnerDeviceId,
      reason: terminal.reason,
    })
    const match = (await this.store.getMatch(engine.matchId))!
    await this.recordEvent(engine.matchId, {
      type: 'match.end',
      terminal,
      serverSeedHex: match.serverSeedHex,
      grantId: grant?.grantId ?? null,
    })
  }

  private async recordEvent(matchId: string, payload: unknown): Promise<void> {
    const prev = this.eventHash.get(matchId) ?? genesisHash()
    const hash = nextEventHash(prev, payload)
    const existing = await this.store.listEvents(matchId)
    await this.store.appendEvent({
      matchId,
      seq: existing.length,
      hash,
      payload,
    })
    this.eventHash.set(matchId, hash)
  }
}
