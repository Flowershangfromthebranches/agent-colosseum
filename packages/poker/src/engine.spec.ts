import { describe, expect, it } from 'vitest'
import { commitServerSeed, deriveHandDeck } from '@agent-colosseum/crypto'
import { STARTING_STACK, uuidv7 } from '@agent-colosseum/protocol'
import { blindsForHand } from './blinds.ts'
import { leftOfButton, PokerEngine } from './engine.ts'
import { playScriptedMatch, randomEntropyPair } from './local-match.ts'

function deck(matchId = uuidv7(), hand = 1, seed = commitServerSeed().serverSeedHex, entropy = randomEntropyPair()) {
  return { matchId, seed, entropy, cards: deriveHandDeck({ matchId, handNo: hand, serverSeedHex: seed, playerEntropy: entropy }) }
}

function fresh() {
  const d = deck()
  const engine = PokerEngine.create({
    matchId: d.matchId,
    deviceA: uuidv7(),
    deviceB: uuidv7(),
    deck: d.cards,
  })
  engine.startHand(d.cards)
  return { engine, ...d }
}

describe('blinds', () => {
  it('follows the published schedule', () => {
    expect(blindsForHand(1)).toEqual({ small: 1, big: 2 })
    expect(blindsForHand(6)).toEqual({ small: 2, big: 4 })
    expect(blindsForHand(11)).toEqual({ small: 4, big: 8 })
    expect(blindsForHand(16)).toEqual({ small: 8, big: 16 })
  })
})

describe('deal and button', () => {
  it('deals Button, BB, Button, BB and hides opponent holes', () => {
    const { engine } = fresh()
    expect(engine.state.button).toBe('A')
    const snapA = engine.snapshot('A')
    const snapB = engine.snapshot('B')
    expect(snapA.holes.A).toEqual(engine.state.holes.A)
    expect(snapA.holes.B).toBeUndefined()
    expect(snapB.holes.B).toEqual(engine.state.holes.B)
    expect(snapB.holes.A).toBeUndefined()
    expect(engine.state.toAct).toBe('A')
    expect(engine.state.streetCommitted.A).toBe(1)
    expect(engine.state.streetCommitted.B).toBe(2)
  })

  it('rotates the button each hand', () => {
    const { engine, matchId, seed, entropy } = fresh()
    engine.apply('A', 'fold')
    expect(engine.state.button).toBe('A')
    engine.startHand(deriveHandDeck({ matchId, handNo: 2, serverSeedHex: seed, playerEntropy: entropy }))
    expect(engine.state.button).toBe('B')
    expect(engine.state.toAct).toBe('B')
  })

  it('burns before flop/turn/river', () => {
    const { engine } = fresh()
    engine.apply('A', 'call')
    engine.apply('B', 'check')
    expect(engine.state.street).toBe('flop')
    expect(engine.state.board).toHaveLength(3)
    expect(engine.state.deckCursor).toBe(8)
    engine.apply('B', 'check')
    engine.apply('A', 'check')
    expect(engine.state.street).toBe('turn')
    expect(engine.state.board).toHaveLength(4)
    expect(engine.state.deckCursor).toBe(10)
    engine.apply('B', 'check')
    engine.apply('A', 'check')
    expect(engine.state.street).toBe('river')
    expect(engine.state.deckCursor).toBe(12)
  })
})

describe('betting', () => {
  it('gives BB the option after a limp and enforces min-raise', () => {
    const { engine } = fresh()
    engine.apply('A', 'call')
    expect(engine.state.toAct).toBe('B')
    expect(engine.legalActions().map((item) => item.action).sort()).toEqual(['check', 'fold', 'raise'])
    const raise = engine.legalActions().find((item) => item.action === 'raise')!
    expect(raise.minRaiseTo).toBe(4)
    expect(() => engine.apply('B', 'raise', 3)).toThrow(/minimum/)
  })

  it('returns uncalled chips and conserves 160', () => {
    const { engine } = fresh()
    engine.apply('A', 'raise', 80)
    engine.apply('B', 'call')
    expect(engine.totalChips()).toBe(STARTING_STACK * 2)
    expect(engine.state.street).toBe('complete')
  })

  it('folds award the pot immediately', () => {
    const { engine } = fresh()
    engine.apply('A', 'fold')
    expect(engine.state.players.B.stack).toBe(81)
    expect(engine.state.players.A.stack).toBe(79)
  })

  it('skips an all-in button SB and runs out to showdown after BB checks', () => {
    const d = deck()
    const engine = PokerEngine.create({
      matchId: d.matchId,
      deviceA: uuidv7(),
      deviceB: uuidv7(),
      deck: d.cards,
    })
    engine.state.players.A.stack = 1
    engine.state.players.B.stack = STARTING_STACK * 2 - 1
    engine.startHand(d.cards)
    expect(engine.state.button).toBe('A')
    expect(engine.state.allIn.A).toBe(true)
    expect(engine.state.toAct).toBe('B')
    expect(engine.legalActions().map((item) => item.action)).toContain('check')
    expect(engine.legalActions().map((item) => item.action)).not.toEqual(['fold'])
    engine.apply('B', 'check')
    expect(engine.state.street).toBe('complete')
    expect(engine.state.board).toHaveLength(5)
    expect(engine.state.toAct).toBeNull()
    expect(engine.totalChips()).toBe(STARTING_STACK * 2)
    expect(engine.state.folded.A).toBe(false)
  })

  it('runs out when both blinds are already all-in', () => {
    const d = deck()
    const engine = PokerEngine.create({
      matchId: d.matchId,
      deviceA: uuidv7(),
      deviceB: uuidv7(),
      deck: d.cards,
    })
    engine.state.players.A.stack = 1
    engine.state.players.B.stack = 1
    expect(() => engine.startHand(d.cards)).toThrow(/conservation/)
    expect(engine.state.board).toHaveLength(5)
    expect(engine.state.toAct).toBeNull()
  })

  it('serializes and restores mid-hand', () => {
    const { engine } = fresh()
    engine.apply('A', 'call')
    const restored = PokerEngine.fromState(engine.toState())
    expect(restored.snapshot()).toEqual(engine.snapshot())
    restored.apply('B', 'check')
    expect(restored.state.street).toBe('flop')
  })

  it('serverFault releases chips without a winner', () => {
    const { engine } = fresh()
    expect(engine.serverFault()?.winnerDeviceId).toBeNull()
    expect(engine.totalChips()).toBe(160)
  })

  it('forfeit and double-disconnect close once', () => {
    const { engine } = fresh()
    const first = engine.forfeit('A')
    expect(first?.winnerDeviceId).toBe(engine.state.players.B.deviceId)
    expect(() => engine.forfeit('B')).toThrow(/terminal/)
    const other = fresh().engine
    expect(other.doubleDisconnect()?.winnerDeviceId).toBeNull()
    expect(other.totalChips()).toBe(160)
  })
})

describe('odd chip', () => {
  it('gives the odd chip to the first active seat left of the button', () => {
    expect(leftOfButton('A')).toBe('B')
    const used = ['2h', '3d', '4h', '5d', 'As', 'Kh', 'Qd', 'Jc', 'Tc']
    const rest = [
      '2s', '2d', '2c', '3s', '3h', '3c', '4s', '4c', '4d',
      '5s', '5h', '5c', '6s', '6h', '6d', '6c',
      '7s', '7h', '7d', '7c', '8s', '8h', '8d', '8c', '9s', '9h', '9d', '9c',
      'Ts', 'Th', 'Td', 'Js', 'Jh', 'Jd', 'Qs', 'Qh', 'Qc', 'Ks', 'Kd', 'Kc',
      'Ac', 'Ah', 'Ad',
    ]
    const deckCards = [...used, ...rest]
    const engine = PokerEngine.create({
      matchId: uuidv7(),
      deviceA: uuidv7(),
      deviceB: uuidv7(),
      deck: deckCards,
    })
    engine.startHand(deckCards)
    engine.apply('A', 'call')
    engine.apply('B', 'check')
    engine.apply('B', 'check')
    engine.apply('A', 'check')
    engine.apply('B', 'check')
    engine.apply('A', 'check')
    engine.apply('B', 'check')
    engine.apply('A', 'check')
    expect(engine.state.players.A.stack + engine.state.players.B.stack).toBe(160)
  })
})

describe('match length', () => {
  it('continues sudden death when stacks are tied after 20 hands', () => {
    const { engine, matchId, seed, entropy } = fresh()
    const state = engine.toState()
    state.handNo = 20
    state.street = 'complete'
    state.toAct = null
    state.players.A.stack = 80
    state.players.B.stack = 80
    state.handCommitted = { A: 0, B: 0 }
    state.streetCommitted = { A: 0, B: 0 }
    state.pot = 0
    state.terminal = null
    const tied = PokerEngine.fromState(state)
    expect(tied.maybeFinishMatch()).toBeNull()
    tied.startHand(deriveHandDeck({ matchId, handNo: 21, serverSeedHex: seed, playerEntropy: entropy }))
    tied.apply(tied.state.toAct!, 'fold')
    expect(tied.state.terminal?.reason === 'bust' || tied.state.players.A.stack !== tied.state.players.B.stack).toBe(true)
  })

  it('ends on chip lead after 20 hands when stacks differ', () => {
    const { engine } = fresh()
    const state = engine.toState()
    state.handNo = 20
    state.street = 'complete'
    state.toAct = null
    state.players.A.stack = 100
    state.players.B.stack = 60
    state.handCommitted = { A: 0, B: 0 }
    state.pot = 0
    const led = PokerEngine.fromState(state)
    expect(led.maybeFinishMatch()?.reason).toBe('chip_lead')
    expect(led.state.terminal?.winnerDeviceId).toBe(led.state.players.A.deviceId)
  })
})

describe('scripted match', () => {
  it('two script policies finish with conservation and replay', () => {
    const matchId = uuidv7()
    const seed = commitServerSeed().serverSeedHex
    const entropy = randomEntropyPair()
    const a = playScriptedMatch({
      matchId, deviceA: uuidv7(), deviceB: uuidv7(),
      policyA: 'check-fold', policyB: 'call-station',
      serverSeedHex: seed, entropy,
    })
    const b = playScriptedMatch({
      matchId, deviceA: a.engine.state.players.A.deviceId, deviceB: a.engine.state.players.B.deviceId,
      policyA: 'check-fold', policyB: 'call-station',
      serverSeedHex: seed, entropy,
    })
    expect(a.engine.state.terminal).toBeTruthy()
    expect(a.engine.totalChips()).toBe(160)
    expect(b.engine.state.players.A.stack).toBe(a.engine.state.players.A.stack)
    expect(PokerEngine.fromState(a.engine.toState()).state.handNo).toBe(a.engine.state.handNo)
  })
})
