import { MAX_HANDS, STARTING_STACK } from '@agent-colosseum/protocol'
import { dealFromDeck } from '@agent-colosseum/crypto'
import { blindsForHand } from './blinds.ts'
import { assertUniqueCards, compareHoles } from './evaluate.ts'
import type {
  AppliedAction,
  HandResult,
  LegalAction,
  MatchConfig,
  MatchTerminal,
  PlayerState,
  PublicMatchSnapshot,
  Seat,
  Street,
} from './types.ts'

const OTHER: Record<Seat, Seat> = { button: 'bb', bb: 'button' }

export class PokerEngine {
  readonly matchId: string
  readonly buttonDeviceId: string
  readonly bbDeviceId: string
  private readonly startingStack: number
  handNo = 0
  actionSeq = 0
  street: Street = 'complete'
  players: Record<Seat, PlayerState>
  board: string[] = []
  holes: Record<Seat, [string, string] | null> = { button: null, bb: null }
  currentBet = 0
  lastRaiseSize = 0
  toAct: Seat | null = null
  pot = 0
  lastActions: AppliedAction[] = []
  terminal: MatchTerminal | null = null
  private streetOpener: Seat = 'bb'
  private actedThisStreet = new Set<Seat>()
  private pendingUncalled: { seat: Seat; amount: number } | null = null

  constructor(config: MatchConfig) {
    this.matchId = config.matchId
    this.buttonDeviceId = config.buttonDeviceId
    this.bbDeviceId = config.bbDeviceId
    this.startingStack = config.startingStack ?? STARTING_STACK
    this.players = {
      button: emptyPlayer('button', config.buttonDeviceId, this.startingStack),
      bb: emptyPlayer('bb', config.bbDeviceId, this.startingStack),
    }
  }

  totalChips(): number {
    return this.players.button.stack + this.players.bb.stack
      + this.players.button.handCommitted + this.players.bb.handCommitted
  }

  startHand(deck: readonly string[]): void {
    this.assertLive()
    if (this.street !== 'complete') throw new Error('hand already in progress')
    this.handNo += 1
    const dealt = dealFromDeck(deck)
    assertUniqueCards([...dealt.buttonHole, ...dealt.bbHole, ...dealt.board])
    this.board = [...dealt.board]
    this.holes = { button: dealt.buttonHole, bb: dealt.bbHole }
    this.actionSeq = 0
    this.lastActions = []
    this.pendingUncalled = null
    this.street = 'preflop'
    this.actedThisStreet = new Set()
    for (const seat of ['button', 'bb'] as const) {
      this.players[seat].streetCommitted = 0
      this.players[seat].handCommitted = 0
      this.players[seat].folded = false
      this.players[seat].allIn = this.players[seat].stack === 0
    }
    const blinds = blindsForHand(this.handNo)
    this.postBlind('button', blinds.small)
    this.postBlind('bb', blinds.big)
    this.currentBet = Math.max(this.players.button.streetCommitted, this.players.bb.streetCommitted)
    this.lastRaiseSize = blinds.big
    this.streetOpener = 'button'
    this.toAct = this.players.button.allIn && this.players.bb.allIn ? null : 'button'
    this.recomputePot()
    if (this.players.button.allIn && this.players.bb.allIn) this.runOut()
  }

  legalActions(): LegalAction[] {
    if (this.terminal || this.toAct === null || this.street === 'complete' || this.street === 'showdown') {
      return []
    }
    const actor = this.players[this.toAct]
    const toCall = this.currentBet - actor.streetCommitted
    const actions: LegalAction[] = [{ action: 'fold' }]
    if (toCall <= 0) actions.push({ action: 'check' })
    if (toCall > 0 && actor.stack > 0) actions.push({ action: 'call' })
    const opponent = this.players[OTHER[this.toAct]]
    const minRaiseTo = this.currentBet + this.lastRaiseSize
    const maxRaiseTo = actor.streetCommitted + actor.stack
    if (!opponent.allIn && actor.stack > toCall && maxRaiseTo > this.currentBet) {
      actions.push({
        action: 'raise',
        minRaiseTo: Math.min(minRaiseTo, maxRaiseTo),
        maxRaiseTo,
      })
    }
    return actions
  }

  apply(seat: Seat, action: AppliedAction['action'], raiseTo?: number, publicRationale = '', fault?: AppliedAction['fault']): void {
    this.assertLive()
    if (this.toAct !== seat) throw new Error('not this seat to act')
    const legal = this.legalActions()
    const actor = this.players[seat]
    const allowed = legal.find((item) => item.action === action)
    if (!allowed) throw new Error(`illegal action ${action}`)

    if (action === 'fold') {
      actor.folded = true
    } else if (action === 'check') {
      if (this.currentBet !== actor.streetCommitted) throw new Error('cannot check')
    } else if (action === 'call') {
      const toCall = Math.min(this.currentBet - actor.streetCommitted, actor.stack)
      this.commit(seat, toCall)
    } else {
      const target = raiseTo
      if (target === undefined) throw new Error('raise requires raiseTo')
      const minRaiseTo = allowed.minRaiseTo ?? target
      const maxRaiseTo = allowed.maxRaiseTo ?? target
      if (target > maxRaiseTo) throw new Error('raise exceeds stack')
      const isAllIn = target === maxRaiseTo
      if (target < minRaiseTo && !isAllIn) throw new Error('below minimum raise')
      const increment = target - this.currentBet
      this.commit(seat, target - actor.streetCommitted)
      if (increment >= this.lastRaiseSize) {
        this.lastRaiseSize = increment
        this.actedThisStreet = new Set([seat])
      }
      this.currentBet = Math.max(this.currentBet, actor.streetCommitted)
    }

    this.actedThisStreet.add(seat)
    this.actionSeq += 1
    this.lastActions.push({
      seat,
      action,
      publicRationale,
      ...raiseTo === undefined ? {} : { raiseTo },
      ...fault === undefined ? {} : { fault },
    })
    this.recomputePot()
    this.advanceAfterAction()
  }

  autoFault(seat: Seat): AppliedAction {
    const legal = this.legalActions()
    const canCheck = legal.some((item) => item.action === 'check')
    const action = canCheck ? 'check' : 'fold'
    this.apply(seat, action, undefined, '', 'agent_fault')
    return this.lastActions.at(-1)!
  }

  snapshot(viewer?: Seat): PublicMatchSnapshot {
    const blinds = this.handNo === 0 ? blindsForHand(1) : blindsForHand(this.handNo)
    const holes: PublicMatchSnapshot['holes'] = {}
    if (this.street === 'showdown' || this.street === 'complete') {
      if (this.holes.button) holes.button = this.holes.button
      if (this.holes.bb) holes.bb = this.holes.bb
    } else if (viewer && this.holes[viewer]) {
      holes[viewer] = this.holes[viewer]!
    }
    const boardCards = boardForStreet(this.street, this.board)
    return {
      matchId: this.matchId,
      handNo: this.handNo,
      actionSeq: this.actionSeq,
      street: this.street,
      buttonDeviceId: this.buttonDeviceId,
      bbDeviceId: this.bbDeviceId,
      stacks: { button: this.players.button.stack, bb: this.players.bb.stack },
      streetCommitted: {
        button: this.players.button.streetCommitted,
        bb: this.players.bb.streetCommitted,
      },
      pot: this.pot,
      currentBet: this.currentBet,
      toAct: this.toAct,
      legal: viewer === undefined || viewer === this.toAct ? this.legalActions() : [],
      board: boardCards,
      holes,
      blinds,
      lastActions: [...this.lastActions],
      terminal: this.terminal,
    }
  }

  forfeit(loserSeat: Seat, reason: MatchTerminal['reason'] = 'forfeit'): MatchTerminal {
    this.assertLive()
    const winner = OTHER[loserSeat]
    this.awardRemainingTo(winner)
    return this.close(reason, this.players[winner].deviceId)
  }

  doubleDisconnect(): MatchTerminal {
    this.assertLive()
    this.returnStreetToStacks()
    return this.close('double_disconnect', null)
  }

  serverFault(): MatchTerminal {
    this.assertLive()
    this.returnStreetToStacks()
    return this.close('server_fault', null)
  }

  maybeFinishMatch(): MatchTerminal | null {
    if (this.terminal) return this.terminal
    if (this.street !== 'complete') return null
    const busted = (['button', 'bb'] as const).find((seat) => this.players[seat].stack <= 0)
    if (busted) {
      return this.close('bust', this.players[OTHER[busted]].deviceId)
    }
    if (this.handNo >= MAX_HANDS) {
      if (this.players.button.stack === this.players.bb.stack) return null
      const winner = this.players.button.stack > this.players.bb.stack ? 'button' : 'bb'
      return this.close('chip_lead', this.players[winner].deviceId)
    }
    return null
  }

  seatOf(deviceId: string): Seat {
    if (deviceId === this.buttonDeviceId) return 'button'
    if (deviceId === this.bbDeviceId) return 'bb'
    throw new Error('unknown device')
  }

  deviceOf(seat: Seat): string {
    return this.players[seat].deviceId
  }

  private postBlind(seat: Seat, amount: number): void {
    const posted = Math.min(amount, this.players[seat].stack)
    this.commit(seat, posted)
  }

  private commit(seat: Seat, amount: number): void {
    if (amount < 0) throw new Error('negative commit')
    const player = this.players[seat]
    if (amount > player.stack) throw new Error('commit exceeds stack')
    player.stack -= amount
    player.streetCommitted += amount
    player.handCommitted += amount
    if (player.stack === 0) player.allIn = true
  }

  private recomputePot(): void {
    this.pot = this.players.button.handCommitted + this.players.bb.handCommitted
  }

  private advanceAfterAction(): void {
    if (this.players.button.folded || this.players.bb.folded) {
      this.finishHandByFold()
      return
    }
    if (this.streetClosed()) {
      this.nextStreet()
      return
    }
    const next = OTHER[this.toAct!]
    if (this.players[next].allIn || this.players[next].folded) {
      if (this.streetClosed()) this.nextStreet()
      else this.toAct = this.toAct
      return
    }
    this.toAct = next
  }

  private streetClosed(): boolean {
    const live = (['button', 'bb'] as const).filter((seat) => !this.players[seat].folded)
    if (live.length < 2) return true
    if (live.every((seat) => this.players[seat].allIn || this.players[seat].streetCommitted === this.currentBet)
      && live.every((seat) => this.actedThisStreet.has(seat) || this.players[seat].allIn)) {
      return true
    }
    // Preflop: BB option if no raise. Button already acted, BB matched blinds.
    return false
  }

  private nextStreet(): void {
    this.returnUncalledBet()
    for (const seat of ['button', 'bb'] as const) {
      this.players[seat].streetCommitted = 0
    }
    this.currentBet = 0
    this.lastRaiseSize = blindsForHand(this.handNo).big
    this.actedThisStreet = new Set()
    const bothAllIn = this.players.button.allIn || this.players.bb.allIn
    if (this.street === 'preflop') this.street = 'flop'
    else if (this.street === 'flop') this.street = 'turn'
    else if (this.street === 'turn') this.street = 'river'
    else {
      this.showdown()
      return
    }
    if (bothAllIn) {
      this.runOut()
      return
    }
    this.toAct = 'bb'
    this.streetOpener = 'bb'
    if (this.players.bb.allIn || this.players.bb.folded) this.toAct = 'button'
    if (this.players.button.allIn && this.players.bb.allIn) this.runOut()
  }

  private runOut(): void {
    this.returnUncalledBet()
    this.street = 'showdown'
    this.toAct = null
    this.showdown()
  }

  private finishHandByFold(): void {
    this.returnUncalledBet()
    const winner = this.players.button.folded ? 'bb' : 'button'
    this.players[winner].stack += this.pot
    this.players.button.handCommitted = 0
    this.players.bb.handCommitted = 0
    this.pot = 0
    this.street = 'complete'
    this.toAct = null
    this.assertConservation()
    this.maybeFinishMatch()
  }

  private showdown(): void {
    this.returnUncalledBet()
    const result = this.awardShowdown()
    void result
    this.street = 'complete'
    this.toAct = null
    this.assertConservation()
    this.maybeFinishMatch()
  }

  private awardShowdown(): HandResult {
    const winners = compareHoles(this.holes.button!, this.holes.bb!, this.board)
    const pot = this.pot
    if (winners.length === 2) {
      const share = Math.floor(pot / 2)
      const odd = pot - share * 2
      this.players.button.stack += share
      this.players.bb.stack += share
      // odd chip to the button (SB) — standard leftover to first seat after dealer
      if (odd) this.players.button.stack += odd
      this.players.button.handCommitted = 0
      this.players.bb.handCommitted = 0
      this.pot = 0
      return {
        winners,
        pot,
        oddChipTo: odd ? 'button' : null,
        returnedUncalled: this.pendingUncalled,
        shown: { button: this.holes.button!, bb: this.holes.bb! },
      }
    }
    const winner = winners[0]!
    this.players[winner].stack += pot
    this.players.button.handCommitted = 0
    this.players.bb.handCommitted = 0
    this.pot = 0
    return {
      winners,
      pot,
      oddChipTo: null,
      returnedUncalled: this.pendingUncalled,
      shown: { button: this.holes.button!, bb: this.holes.bb! },
    }
  }

  private returnUncalledBet(): void {
    const a = this.players.button.streetCommitted
    const b = this.players.bb.streetCommitted
    if (a === b) {
      this.pendingUncalled = null
      return
    }
    const high = a > b ? 'button' : 'bb'
    const low = OTHER[high]
    const extra = this.players[high].streetCommitted - this.players[low].streetCommitted
    if (extra <= 0) return
    this.players[high].streetCommitted -= extra
    this.players[high].handCommitted -= extra
    this.players[high].stack += extra
    this.pendingUncalled = { seat: high, amount: extra }
    this.recomputePot()
  }

  private returnStreetToStacks(): void {
    for (const seat of ['button', 'bb'] as const) {
      const player = this.players[seat]
      player.stack += player.handCommitted
      player.handCommitted = 0
      player.streetCommitted = 0
    }
    this.pot = 0
    this.street = 'complete'
    this.toAct = null
  }

  private awardRemainingTo(winner: Seat): void {
    this.players[winner].stack += this.players.button.handCommitted + this.players.bb.handCommitted
    this.players.button.handCommitted = 0
    this.players.bb.handCommitted = 0
    this.pot = 0
    this.street = 'complete'
    this.toAct = null
  }

  private close(reason: MatchTerminal['reason'], winnerDeviceId: string | null): MatchTerminal {
    this.terminal = {
      reason,
      winnerDeviceId,
      stacks: {
        [this.buttonDeviceId]: this.players.button.stack,
        [this.bbDeviceId]: this.players.bb.stack,
      },
      grantTransferred: winnerDeviceId !== null && (reason === 'bust' || reason === 'chip_lead' || reason === 'forfeit'),
    }
    return this.terminal
  }

  private assertLive(): void {
    if (this.terminal) throw new Error('match already terminal')
  }

  private assertConservation(): void {
    const total = this.players.button.stack + this.players.bb.stack
      + this.players.button.handCommitted + this.players.bb.handCommitted
    if (total !== this.startingStack * 2) {
      throw new Error(`chip conservation violated: ${total} != ${this.startingStack * 2}`)
    }
  }
}

function emptyPlayer(seat: Seat, deviceId: string, stack: number): PlayerState {
  return {
    seat,
    deviceId,
    stack,
    streetCommitted: 0,
    handCommitted: 0,
    folded: false,
    allIn: false,
  }
}

function boardForStreet(street: Street, board: string[]): string[] {
  if (street === 'preflop') return []
  if (street === 'flop') return board.slice(0, 3)
  if (street === 'turn') return board.slice(0, 4)
  return [...board]
}
