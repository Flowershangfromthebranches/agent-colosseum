import {
  MAX_HANDS,
  SCHEMA_VERSION,
  STARTING_STACK,
  pokerMatchStateSchema,
  type PokerActionKind,
  type PokerMatchStateV1,
  type SeatId,
} from '@agent-colosseum/protocol'
import { blindsForHand } from './blinds.ts'
import { assertUniqueCards, compareHoles } from './evaluate.ts'
import type { LegalAction, PublicMatchSnapshot } from './types.ts'

export const OTHER: Record<SeatId, SeatId> = { A: 'B', B: 'A' }

export function leftOfButton(button: SeatId): SeatId {
  return OTHER[button]
}

export class PokerEngine {
  state: PokerMatchStateV1

  constructor(state: PokerMatchStateV1) {
    this.state = pokerMatchStateSchema.parse(state)
  }

  static create(input: {
    matchId: string
    deviceA: string
    deviceB: string
    deck: readonly string[]
    firstButton?: SeatId
  }): PokerEngine {
    if (new Set(input.deck).size !== 52 || input.deck.length !== 52) {
      throw new Error('deck must be a unique 52-card permutation')
    }
    return new PokerEngine({
      schemaVersion: SCHEMA_VERSION,
      matchId: input.matchId,
      players: {
        A: { deviceId: input.deviceA, stack: STARTING_STACK },
        B: { deviceId: input.deviceB, stack: STARTING_STACK },
      },
      button: input.firstButton ?? 'A',
      handNo: 0,
      street: 'complete',
      actionSeq: 0,
      deck: [...input.deck],
      deckCursor: 0,
      holes: { A: null, B: null },
      board: [],
      streetCommitted: { A: 0, B: 0 },
      handCommitted: { A: 0, B: 0 },
      folded: { A: false, B: false },
      allIn: { A: false, B: false },
      currentBet: 0,
      lastRaiseSize: 0,
      toAct: null,
      pot: 0,
      actedThisStreet: [],
      lastActions: [],
      terminal: null,
      startingStack: STARTING_STACK,
    })
  }

  static fromState(state: unknown): PokerEngine {
    return new PokerEngine(pokerMatchStateSchema.parse(state))
  }

  toState(): PokerMatchStateV1 {
    return pokerMatchStateSchema.parse(this.state)
  }

  totalChips(): number {
    const s = this.state
    return s.players.A.stack + s.players.B.stack + s.handCommitted.A + s.handCommitted.B
  }

  seatOf(deviceId: string): SeatId {
    if (this.state.players.A.deviceId === deviceId) return 'A'
    if (this.state.players.B.deviceId === deviceId) return 'B'
    throw new Error('unknown device')
  }

  startHand(deck: readonly string[]): void {
    this.assertLive()
    if (this.state.street !== 'complete') throw new Error('hand already in progress')
    if (new Set(deck).size !== 52 || deck.length !== 52) throw new Error('deck must be unique 52')
    const button = this.state.handNo === 0 ? this.state.button : OTHER[this.state.button]
    this.state.button = button
    this.state.handNo += 1
    this.state.deck = [...deck]
    this.state.deckCursor = 0
    this.state.lastActions = []
    this.state.actedThisStreet = []
    this.state.street = 'preflop'
    this.state.actionSeq = 0
    this.state.folded = { A: false, B: false }
    this.state.streetCommitted = { A: 0, B: 0 }
    this.state.handCommitted = { A: 0, B: 0 }
    this.state.board = []
    for (const seat of ['A', 'B'] as const) {
      this.state.allIn[seat] = this.state.players[seat].stack === 0
    }
    const bb = OTHER[button]
    const first = this.deal()
    const second = this.deal()
    const third = this.deal()
    const fourth = this.deal()
    this.state.holes[button] = [first, third]
    this.state.holes[bb] = [second, fourth]
    assertUniqueCards([...this.state.holes.A!, ...this.state.holes.B!])
    const blinds = blindsForHand(this.state.handNo)
    this.postBlind(button, blinds.small)
    this.postBlind(bb, blinds.big)
    this.state.currentBet = Math.max(this.state.streetCommitted.A, this.state.streetCommitted.B)
    this.state.lastRaiseSize = blinds.big
    this.recomputePot()
    if (!this.state.allIn[button]) {
      this.state.toAct = button
    } else if (!this.state.allIn[bb]) {
      this.state.toAct = bb
    } else {
      this.state.toAct = null
      this.runOut()
    }
  }

  legalActions(): LegalAction[] {
    const s = this.state
    if (s.terminal || s.toAct === null || s.street === 'complete' || s.street === 'showdown') return []
    const actor = s.toAct
    const toCall = s.currentBet - s.streetCommitted[actor]
    const actions: LegalAction[] = [{ action: 'fold' }]
    if (toCall <= 0) actions.push({ action: 'check' })
    if (toCall > 0 && s.players[actor].stack > 0) actions.push({ action: 'call' })
    const opponent = OTHER[actor]
    const minRaiseTo = s.currentBet + s.lastRaiseSize
    const maxRaiseTo = s.streetCommitted[actor] + s.players[actor].stack
    if (!s.allIn[opponent] && s.players[actor].stack > toCall && maxRaiseTo > s.currentBet) {
      actions.push({
        action: 'raise',
        minRaiseTo,
        maxRaiseTo,
      })
    }
    return actions
  }

  apply(seat: SeatId, action: PokerActionKind, raiseTo?: number, publicRationale = '', fault?: 'agent_fault' | 'timeout' | 'illegal'): void {
    this.assertLive()
    if (this.state.toAct !== seat) throw new Error('not this seat to act')
    const legal = this.legalActions()
    const allowed = legal.find((item) => item.action === action)
    if (!allowed) throw new Error(`illegal action ${action}`)
    const s = this.state
    if (action === 'fold') {
      s.folded[seat] = true
    } else if (action === 'check') {
      // legalActions already requires toCall <= 0
    } else if (action === 'call') {
      const toCall = Math.min(s.currentBet - s.streetCommitted[seat], s.players[seat].stack)
      this.commit(seat, toCall)
    } else {
      if (raiseTo === undefined) throw new Error('raise requires raiseTo')
      const minRaiseTo = allowed.minRaiseTo!
      const maxRaiseTo = allowed.maxRaiseTo!
      if (raiseTo > maxRaiseTo) throw new Error('raise exceeds stack')
      const isAllIn = raiseTo === maxRaiseTo
      if (raiseTo < minRaiseTo && !isAllIn) throw new Error('below minimum raise')
      const increment = raiseTo - s.currentBet
      this.commit(seat, raiseTo - s.streetCommitted[seat])
      if (increment >= s.lastRaiseSize) {
        s.lastRaiseSize = increment
        s.actedThisStreet = [seat]
      }
      s.currentBet = Math.max(s.currentBet, s.streetCommitted[seat])
    }
    if (!s.actedThisStreet.includes(seat)) s.actedThisStreet.push(seat)
    s.actionSeq += 1
    s.lastActions.push({
      seat,
      action,
      publicRationale,
      ...raiseTo === undefined ? {} : { raiseTo },
      ...fault === undefined ? {} : { fault },
    })
    this.recomputePot()
    this.advanceAfterAction()
  }

  autoFault(seat: SeatId): PokerMatchStateV1['lastActions'][number] {
    const canCheck = this.legalActions().some((item) => item.action === 'check')
    this.apply(seat, canCheck ? 'check' : 'fold', undefined, '', 'agent_fault')
    return this.state.lastActions.at(-1)!
  }

  snapshot(viewer?: SeatId): PublicMatchSnapshot {
    const s = this.state
    const holes: PublicMatchSnapshot['holes'] = {}
    const revealed = s.street === 'showdown' || s.street === 'complete'
    if (revealed) {
      if (s.holes.A) holes.A = s.holes.A
      if (s.holes.B) holes.B = s.holes.B
    } else if (viewer && s.holes[viewer]) {
      holes[viewer] = s.holes[viewer]!
    }
    return {
      matchId: s.matchId,
      handNo: s.handNo,
      actionSeq: s.actionSeq,
      street: s.street,
      button: s.button,
      seats: {
        A: { deviceId: s.players.A.deviceId, stack: s.players.A.stack, streetCommitted: s.streetCommitted.A },
        B: { deviceId: s.players.B.deviceId, stack: s.players.B.stack, streetCommitted: s.streetCommitted.B },
      },
      pot: s.pot,
      currentBet: s.currentBet,
      toAct: s.toAct,
      legal: viewer === undefined || viewer === s.toAct ? this.legalActions() : [],
      board: boardForStreet(s.street, s.board),
      holes,
      blinds: s.handNo === 0 ? blindsForHand(1) : blindsForHand(s.handNo),
      lastActions: s.lastActions.map((action) => ({
        seat: action.seat,
        action: action.action,
        publicRationale: action.publicRationale,
        ...action.raiseTo === undefined ? {} : { raiseTo: action.raiseTo },
        ...action.fault === undefined ? {} : { fault: action.fault },
      })),
      terminal: s.terminal,
    }
  }

  forfeit(loser: SeatId, reason = 'forfeit'): PokerMatchStateV1['terminal'] {
    this.assertLive()
    const winner = OTHER[loser]
    this.awardRemainingTo(winner)
    return this.close(reason, this.state.players[winner].deviceId)
  }

  doubleDisconnect(): PokerMatchStateV1['terminal'] {
    this.assertLive()
    this.returnCommittedToStacks()
    return this.close('double_disconnect', null)
  }

  serverFault(): PokerMatchStateV1['terminal'] {
    this.assertLive()
    this.returnCommittedToStacks()
    return this.close('server_fault', null)
  }

  maybeFinishMatch(): PokerMatchStateV1['terminal'] {
    if (this.state.terminal) return this.state.terminal
    if (this.state.street !== 'complete') return null
    const busted = (['A', 'B'] as const).find((seat) => this.state.players[seat].stack <= 0)
    if (busted) return this.close('bust', this.state.players[OTHER[busted]].deviceId)
    if (this.state.handNo >= MAX_HANDS) {
      if (this.state.players.A.stack === this.state.players.B.stack) return null
      const winner = this.state.players.A.stack > this.state.players.B.stack ? 'A' : 'B'
      return this.close('chip_lead', this.state.players[winner].deviceId)
    }
    return null
  }

  private deal(): string {
    const card = this.state.deck[this.state.deckCursor]
    if (!card) throw new Error('deck underflow')
    this.state.deckCursor += 1
    return card
  }

  private burn(): void {
    this.deal()
  }

  private postBlind(seat: SeatId, amount: number): void {
    this.commit(seat, Math.min(amount, this.state.players[seat].stack))
  }

  private commit(seat: SeatId, amount: number): void {
    if (amount < 0) throw new Error('negative commit')
    if (amount > this.state.players[seat].stack) throw new Error('commit exceeds stack')
    this.state.players[seat].stack -= amount
    this.state.streetCommitted[seat] += amount
    this.state.handCommitted[seat] += amount
    if (this.state.players[seat].stack === 0) this.state.allIn[seat] = true
  }

  private recomputePot(): void {
    this.state.pot = this.state.handCommitted.A + this.state.handCommitted.B
  }

  private advanceAfterAction(): void {
    if (this.state.folded.A || this.state.folded.B) {
      this.finishHandByFold()
      return
    }
    if (this.streetClosed()) {
      this.nextStreet()
      return
    }
    this.state.toAct = OTHER[this.state.toAct!]
  }

  private streetClosed(): boolean {
    const live = (['A', 'B'] as const).filter((seat) => !this.state.folded[seat])
    if (live.length < 2) return true
    return live.every((seat) =>
      (this.state.allIn[seat] || this.state.streetCommitted[seat] === this.state.currentBet)
      && (this.state.actedThisStreet.includes(seat) || this.state.allIn[seat]),
    )
  }

  private nextStreet(): void {
    this.returnUncalledBet()
    this.state.streetCommitted = { A: 0, B: 0 }
    this.state.currentBet = 0
    this.state.lastRaiseSize = blindsForHand(this.state.handNo).big
    this.state.actedThisStreet = []
    if (this.state.street === 'preflop') {
      this.burn()
      this.state.board = [this.deal(), this.deal(), this.deal()]
      this.state.street = 'flop'
    } else if (this.state.street === 'flop') {
      this.burn()
      this.state.board.push(this.deal())
      this.state.street = 'turn'
    } else if (this.state.street === 'turn') {
      this.burn()
      this.state.board.push(this.deal())
      this.state.street = 'river'
    } else {
      this.showdown()
      return
    }
    assertUniqueCards([...this.state.holes.A ?? [], ...this.state.holes.B ?? [], ...this.state.board])
    if (this.state.allIn.A || this.state.allIn.B) {
      this.runOut()
      return
    }
    this.state.toAct = OTHER[this.state.button]
  }

  private runOut(): void {
    this.returnUncalledBet()
    while (this.state.board.length < 5) {
      this.burn()
      if (this.state.board.length === 0) {
        this.state.board.push(this.deal(), this.deal(), this.deal())
      } else {
        this.state.board.push(this.deal())
      }
    }
    this.state.street = 'showdown'
    this.state.toAct = null
    this.showdown()
  }

  private finishHandByFold(): void {
    this.returnUncalledBet()
    const winner = this.state.folded.A ? 'B' : 'A'
    this.state.players[winner].stack += this.state.pot
    this.state.handCommitted = { A: 0, B: 0 }
    this.state.pot = 0
    this.state.street = 'complete'
    this.state.toAct = null
    this.assertConservation()
    this.maybeFinishMatch()
  }

  private showdown(): void {
    this.returnUncalledBet()
    const winners = compareHoles(this.state.holes.A!, this.state.holes.B!, this.state.board)
    const pot = this.state.pot
    if (winners.length === 2) {
      const share = Math.floor(pot / 2)
      const odd = pot - share * 2
      this.state.players.A.stack += share
      this.state.players.B.stack += share
      this.state.players[leftOfButton(this.state.button)].stack += odd
    } else {
      this.state.players[winners[0]!].stack += pot
    }
    this.state.handCommitted = { A: 0, B: 0 }
    this.state.pot = 0
    this.state.street = 'complete'
    this.state.toAct = null
    this.assertConservation()
    this.maybeFinishMatch()
  }

  private returnUncalledBet(): void {
    const a = this.state.streetCommitted.A
    const b = this.state.streetCommitted.B
    if (a === b) return
    const high: SeatId = a > b ? 'A' : 'B'
    const extra = this.state.streetCommitted[high] - this.state.streetCommitted[OTHER[high]]
    this.state.streetCommitted[high] -= extra
    this.state.handCommitted[high] -= extra
    this.state.players[high].stack += extra
    this.recomputePot()
  }

  private returnCommittedToStacks(): void {
    for (const seat of ['A', 'B'] as const) {
      this.state.players[seat].stack += this.state.handCommitted[seat]
      this.state.handCommitted[seat] = 0
      this.state.streetCommitted[seat] = 0
    }
    this.state.pot = 0
    this.state.street = 'complete'
    this.state.toAct = null
  }

  private awardRemainingTo(winner: SeatId): void {
    this.state.players[winner].stack += this.state.handCommitted.A + this.state.handCommitted.B
    this.state.handCommitted = { A: 0, B: 0 }
    this.state.pot = 0
    this.state.street = 'complete'
    this.state.toAct = null
  }

  private close(reason: string, winnerDeviceId: string | null): PokerMatchStateV1['terminal'] {
    this.state.terminal = {
      reason,
      winnerDeviceId,
      stacks: {
        [this.state.players.A.deviceId]: this.state.players.A.stack,
        [this.state.players.B.deviceId]: this.state.players.B.stack,
      },
      grantTransferred: winnerDeviceId !== null && (reason === 'bust' || reason === 'chip_lead' || reason === 'forfeit'),
    }
    return this.state.terminal
  }

  private assertLive(): void {
    if (this.state.terminal) throw new Error('match already terminal')
  }

  private assertConservation(): void {
    if (this.totalChips() !== STARTING_STACK * 2) {
      throw new Error(`chip conservation violated: ${this.totalChips()}`)
    }
  }
}

function boardForStreet(street: StreetLike, board: string[]): string[] {
  if (street === 'preflop') return []
  if (street === 'flop') return board.slice(0, 3)
  if (street === 'turn') return board.slice(0, 4)
  return [...board]
}

type StreetLike = PokerMatchStateV1['street']
