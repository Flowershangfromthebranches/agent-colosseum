import { describe, expect, it } from 'vitest'
import { commitServerSeed, deriveHandDeck } from '@agent-colosseum/crypto'
import { MAX_HANDS, STARTING_STACK, uuidv7 } from '@agent-colosseum/protocol'
import { PokerEngine } from './engine.ts'
import { randomEntropyPair } from './local-match.ts'
import { assertUniqueCards, compareHoles } from './evaluate.ts'

function cards() {
  const matchId = uuidv7()
  return deriveHandDeck({
    matchId,
    handNo: 1,
    serverSeedHex: commitServerSeed().serverSeedHex,
    playerEntropy: randomEntropyPair(),
  })
}

function engine() {
  const deck = cards()
  const e = PokerEngine.create({
    matchId: uuidv7(),
    deviceA: uuidv7(),
    deviceB: uuidv7(),
    deck,
    firstButton: 'B',
  })
  e.startHand(deck)
  return e
}

describe('engine error and edge branches', () => {
  it('rejects bad decks, unknown seats, and illegal timing', () => {
    expect(() => PokerEngine.create({
      matchId: uuidv7(), deviceA: uuidv7(), deviceB: uuidv7(), deck: ['As'],
    })).toThrow(/52/)
    const dup = Array.from({ length: 52 }, () => 'As')
    expect(() => PokerEngine.create({
      matchId: uuidv7(), deviceA: uuidv7(), deviceB: uuidv7(), deck: dup,
    })).toThrow(/52/)
    const e = engine()
    expect(e.seatOf(e.state.players.B.deviceId)).toBe('B')
    expect(() => e.seatOf(uuidv7())).toThrow(/unknown/)
    expect(() => e.startHand(cards())).toThrow(/in progress/)
    const idle = PokerEngine.create({
      matchId: uuidv7(), deviceA: uuidv7(), deviceB: uuidv7(), deck: cards(),
    })
    expect(() => idle.startHand(dup)).toThrow(/unique 52/)
    expect(() => e.apply('A', 'fold')).toThrow(/not this seat/)
    expect(() => e.apply(e.state.toAct!, 'check')).toThrow(/illegal/)
    const live = engine()
    live.apply(live.state.toAct!, 'call')
    expect(() => live.apply(live.state.toAct!, 'check')).not.toThrow()
  })

  it('covers raise limits, short all-in, opponent all-in, and auto-fault', () => {
    const e = engine()
    const seat = e.state.toAct!
    expect(() => e.apply(seat, 'raise')).toThrow(/raiseTo/)
    expect(() => e.apply(seat, 'raise', 10_000)).toThrow(/exceeds/)
    expect(() => e.apply(seat, 'raise', 3)).toThrow(/minimum/)
    e.state.players[seat].stack = 2
    e.apply(seat, 'raise', e.state.streetCommitted[seat] + 2)
    expect(e.state.allIn[seat]).toBe(true)
    const other = engine()
    other.apply(other.state.toAct!, 'fold')
    expect(other.legalActions()).toEqual([])
    const jammed = engine()
    jammed.apply(jammed.state.toAct!, 'raise', 80)
    expect(jammed.legalActions().some((item) => item.action === 'raise')).toBe(false)
  })

  it('reveals holes at showdown and compares equal boards', () => {
    expect(compareHoles(['As', 'Kh'], ['Ad', 'Kc'], ['2c', '3d', '4h', '7s', '9c']).length).toBeGreaterThan(0)
    expect(compareHoles(['2c', '3d'], ['As', 'Ah'], ['2s', '2h', '4d', '7c', '9s'])).toEqual(['A'])
    expect(() => assertUniqueCards(['As', 'As'])).toThrow(/duplicate/)
    assertUniqueCards(['As', 'Kh'])
    const e = engine()
    e.apply(e.state.toAct!, 'fold')
    const snap = e.snapshot()
    expect(snap.holes.A || snap.holes.B).toBeTruthy()
    expect(e.toState().startingStack).toBe(STARTING_STACK)
    const fresh = PokerEngine.create({
      matchId: uuidv7(), deviceA: uuidv7(), deviceB: uuidv7(), deck: cards(),
    })
    expect(fresh.snapshot().blinds.big).toBe(2)
    expect(fresh.legalActions()).toEqual([])
    expect(fresh.maybeFinishMatch()).toBeNull()
  })

  it('auto-faults to fold preflop and check postflop', () => {
    const e = engine()
    const applied = e.autoFault(e.state.toAct!)
    expect(applied.action).toBe('fold')
    expect(applied.fault).toBe('agent_fault')
    const post = engine()
    post.apply(post.state.toAct!, 'call')
    const checked = post.autoFault(post.state.toAct!)
    expect(checked.action).toBe('check')
  })

  it('covers finish reasons, private snapshot, and private commit guards', () => {
    const e = engine()
    const viewer = e.state.toAct === 'A' ? 'B' : 'A'
    expect(e.snapshot(viewer).legal).toEqual([])
    expect(e.snapshot(e.state.toAct!).legal.length).toBeGreaterThan(0)
    e.state.holes.A = null
    const revealed = e.snapshot()
    expect(revealed.board).toEqual([])
    const busted = engine()
    busted.state.street = 'complete'
    busted.state.toAct = null
    busted.state.players.B.stack = 0
    busted.state.handCommitted = { A: 0, B: 0 }
    busted.state.pot = 0
    expect(busted.maybeFinishMatch()?.reason).toBe('bust')
    const led = engine()
    led.state.street = 'complete'
    led.state.toAct = null
    led.state.handNo = MAX_HANDS
    led.state.players.A.stack = 60
    led.state.players.B.stack = 100
    led.state.handCommitted = { A: 0, B: 0 }
    led.state.pot = 0
    expect(led.maybeFinishMatch()?.reason).toBe('chip_lead')
    const already = engine()
    already.forfeit('A')
    expect(already.maybeFinishMatch()?.reason).toBe('forfeit')
    expect(already.legalActions()).toEqual([])
    const hidden = engine()
    hidden.state.street = 'complete'
    hidden.state.holes.A = null
    hidden.state.holes.B = null
    expect(hidden.snapshot().holes.A).toBeUndefined()
    const priv = engine() as unknown as {
      commit(seat: 'A' | 'B', amount: number): void
      deal(): string
      assertConservation(): void
    }
    expect(() => priv.commit('A', -1)).toThrow(/negative/)
    expect(() => priv.commit('A', 10_000)).toThrow(/exceeds/)
    priv.deal()
    const dry = engine()
    dry.state.deckCursor = 52
    expect(() => (dry as unknown as { deal(): string }).deal()).toThrow(/underflow/)
    const broken = engine()
    broken.state.players.A.stack = 1
    expect(() => (broken as unknown as { assertConservation(): void }).assertConservation()).toThrow(/conservation/)
  })

  it('runs out remaining streets after a preflop shove', () => {
    const shove = engine()
    shove.apply(shove.state.toAct!, 'raise', 80)
    if (shove.state.toAct) shove.apply(shove.state.toAct, 'call')
    expect(shove.state.street).toBe('complete')
    expect(shove.totalChips()).toBe(STARTING_STACK * 2)
    expect(shove.snapshot().board.length).toBe(5)
  })

  it('covers runOut from an empty board, river showdown, and incomplete-hole uniqueness', () => {
    const e = engine()
    ;(e as unknown as { runOut(): void }).runOut()
    expect(e.state.street).toBe('complete')
    expect(e.totalChips()).toBe(STARTING_STACK * 2)

    const river = engine()
    river.apply(river.state.toAct!, 'call')
    river.apply(river.state.toAct!, 'check')
    river.apply(river.state.toAct!, 'check')
    river.apply(river.state.toAct!, 'check')
    river.apply(river.state.toAct!, 'check')
    river.apply(river.state.toAct!, 'check')
    expect(river.state.street).toBe('river')
    river.apply(river.state.toAct!, 'check')
    river.apply(river.state.toAct!, 'check')
    expect(river.state.street).toBe('complete')

    const holes = engine()
    holes.state.holes.A = null
    holes.state.holes.B = null
    holes.state.allIn = { A: false, B: false }
    holes.state.street = 'preflop'
    holes.state.actedThisStreet = ['A', 'B']
    holes.state.streetCommitted = { A: holes.state.currentBet, B: holes.state.currentBet }
    ;(holes as unknown as { nextStreet(): void }).nextStreet()
    expect(holes.state.street).toBe('flop')
  })

  it('covers remaining maybeFinish, streetClosed and split-odd branches', () => {
    const live = engine()
    expect(live.maybeFinishMatch()).toBeNull()
    live.state.folded.A = true
    expect((live as unknown as { streetClosed(): boolean }).streetClosed()).toBe(true)
    live.forfeit('B')
    expect(live.maybeFinishMatch()?.reason).toBe('forfeit')

    const split = engine()
    split.state.holes = { A: ['As', 'Ks'], B: ['As', 'Ks'] }
    split.state.board = ['2c', '3d', '4h', '7s', '9c']
    split.state.streetCommitted = { A: 1, B: 1 }
    split.state.handCommitted = { A: 2, B: 1 }
    split.state.pot = 3
    split.state.players.A.stack = 78
    split.state.players.B.stack = 79
    ;(split as unknown as { showdown(): void }).showdown()
    expect(split.totalChips()).toBe(STARTING_STACK * 2)
    expect(split.state.players.A.stack + split.state.players.B.stack).toBe(STARTING_STACK * 2)

    const even = engine()
    even.state.holes = { A: ['As', 'Ks'], B: ['Ad', 'Kd'] }
    even.state.board = ['2c', '3d', '4h', '7s', '9c']
    even.state.pot = 4
    even.state.players.A.stack = STARTING_STACK - 2
    even.state.players.B.stack = STARTING_STACK - 2
    even.state.handCommitted = { A: 2, B: 2 }
    even.state.streetCommitted = { A: 2, B: 2 }
    ;(even as unknown as { showdown(): void }).showdown()
    expect(even.totalChips()).toBe(STARTING_STACK * 2)

    const deck = cards()
    const short = PokerEngine.create({
      matchId: uuidv7(), deviceA: uuidv7(), deviceB: uuidv7(), deck,
    })
    short.state.players.A.stack = 0
    short.state.players.B.stack = 0
    expect(() => short.startHand(deck)).toThrow(/conservation/)
    expect(engine().snapshot('A').board).toEqual([])
  })
})
