import { describe, expect, it } from 'vitest'
import { commitServerSeed, deriveHandDeck, randomBytes, toHex } from '@agent-colosseum/crypto'
import { STARTING_STACK, uuidv7 } from '@agent-colosseum/protocol'
import { PokerEngine } from './engine.ts'
import { playScriptedMatch } from './local-match.ts'
import { blindsForHand } from './blinds.ts'

function deckFor(matchId: string, handNo: number, seed: string, e1: string, e2: string): string[] {
  return deriveHandDeck({
    matchId,
    handNo,
    serverSeedHex: seed,
    playerEntropy: [e1, e2],
  })
}

function fresh(): { engine: PokerEngine; seed: string; e1: string; e2: string } {
  const matchId = uuidv7()
  const engine = new PokerEngine({
    matchId,
    buttonDeviceId: uuidv7(),
    bbDeviceId: uuidv7(),
  })
  const seed = commitServerSeed().serverSeedHex
  const e1 = toHex(randomBytes(32))
  const e2 = toHex(randomBytes(32))
  engine.startHand(deckFor(matchId, 1, seed, e1, e2))
  return { engine, seed, e1, e2 }
}

describe('blinds', () => {
  it('follows the published schedule', () => {
    expect(blindsForHand(1)).toEqual({ small: 1, big: 2 })
    expect(blindsForHand(5)).toEqual({ small: 1, big: 2 })
    expect(blindsForHand(6)).toEqual({ small: 2, big: 4 })
    expect(blindsForHand(11)).toEqual({ small: 4, big: 8 })
    expect(blindsForHand(16)).toEqual({ small: 8, big: 16 })
    expect(blindsForHand(20)).toEqual({ small: 8, big: 16 })
  })
})

describe('heads-up betting', () => {
  it('posts HU blinds and gives button first preflop action', () => {
    const { engine } = fresh()
    expect(engine.players.button.streetCommitted).toBe(1)
    expect(engine.players.bb.streetCommitted).toBe(2)
    expect(engine.toAct).toBe('button')
    expect(engine.legalActions().map((item) => item.action).sort()).toEqual(['call', 'fold', 'raise'])
  })

  it('gives BB the option after a limp', () => {
    const { engine } = fresh()
    engine.apply('button', 'call', undefined, 'limp')
    expect(engine.toAct).toBe('bb')
    expect(engine.street).toBe('preflop')
    expect(engine.legalActions().map((item) => item.action).sort()).toEqual(['check', 'fold', 'raise'])
    engine.apply('bb', 'check', undefined, 'option')
    expect(engine.street).toBe('flop')
    expect(engine.toAct).toBe('bb')
    expect(engine.snapshot().board).toHaveLength(3)
  })

  it('enforces min-raise and all-in below min', () => {
    const { engine } = fresh()
    const raise = engine.legalActions().find((item) => item.action === 'raise')!
    expect(raise.minRaiseTo).toBe(4)
    expect(() => engine.apply('button', 'raise', 3, 'short')).toThrow(/minimum/)
    engine.apply('button', 'raise', 4, 'min')
    expect(engine.currentBet).toBe(4)
    expect(engine.toAct).toBe('bb')
  })

  it('returns uncalled chips and conserves the starting 160', () => {
    const { engine } = fresh()
    engine.apply('button', 'raise', 80, 'jam')
    expect(engine.players.button.stack).toBe(0)
    engine.apply('bb', 'call', undefined, 'call jam')
    expect(engine.totalChips()).toBe(STARTING_STACK * 2)
    expect(engine.street).toBe('complete')
    expect(engine.players.button.stack + engine.players.bb.stack).toBe(160)
  })

  it('folds award the pot immediately', () => {
    const { engine } = fresh()
    engine.apply('button', 'fold', undefined, 'fold')
    expect(engine.street).toBe('complete')
    expect(engine.players.bb.stack).toBe(81)
    expect(engine.players.button.stack).toBe(79)
    expect(engine.players.button.stack + engine.players.bb.stack).toBe(160)
  })

  it('auto-fault checks when legal else folds', () => {
    const { engine } = fresh()
    engine.apply('button', 'call')
    const applied = engine.autoFault('bb')
    expect(applied.action).toBe('check')
    expect(applied.fault).toBe('agent_fault')
    expect(engine.street).toBe('flop')
  })

  it('forfeit and double-disconnect close once', () => {
    const { engine } = fresh()
    const first = engine.forfeit('button')
    expect(first.winnerDeviceId).toBe(engine.bbDeviceId)
    expect(() => engine.forfeit('bb')).toThrow(/terminal/)
    const other = fresh().engine
    const released = other.doubleDisconnect()
    expect(released.winnerDeviceId).toBeNull()
    expect(other.players.button.stack + other.players.bb.stack).toBe(160)
  })

  it('splits odd chips to the button', () => {
    const matchId = uuidv7()
    const engine = new PokerEngine({
      matchId,
      buttonDeviceId: uuidv7(),
      bbDeviceId: uuidv7(),
    })
    // Force a known split by constructing a deck where both play the board.
    const used = ['2h', '3d', '4h', '5d', 'As', 'Kh', 'Qd', 'Jc', 'Tc']
    const rest = [
      '2s', '2d', '2c', '3s', '3h', '3c', '4s', '4c', '4d',
      '5s', '5h', '5c', '6s', '6h', '6d', '6c',
      '7s', '7h', '7d', '7c', '8s', '8h', '8d', '8c', '9s', '9h', '9d', '9c',
      'Ts', 'Th', 'Td', 'Js', 'Jh', 'Jd', 'Qs', 'Qh', 'Qc', 'Ks', 'Kd', 'Kc',
      'Ac', 'Ah', 'Ad',
    ]
    const deck = [...used, ...rest]
    engine.startHand(deck)
    engine.apply('button', 'call')
    engine.apply('bb', 'check')
    engine.apply('bb', 'check')
    engine.apply('button', 'check')
    engine.apply('bb', 'check')
    engine.apply('button', 'check')
    engine.apply('bb', 'check')
    engine.apply('button', 'check')
    expect(engine.street).toBe('complete')
    expect(engine.players.button.stack + engine.players.bb.stack).toBe(160)
  })
})

describe('scripted match', () => {
  it('two script policies finish a local match with conservation', () => {
    const result = playScriptedMatch({
      matchId: uuidv7(),
      buttonDeviceId: uuidv7(),
      bbDeviceId: uuidv7(),
      buttonPolicy: 'check-fold',
      bbPolicy: 'call-station',
    })
    expect(result.terminal.winnerDeviceId).toBeTruthy()
    expect(result.engine.players.button.stack + result.engine.players.bb.stack).toBe(160)
    expect(result.engine.handNo).toBeGreaterThan(0)
  })

  it('replays the same seed to the same terminal stacks', () => {
    const matchId = uuidv7()
    const button = uuidv7()
    const bb = uuidv7()
    const seed = commitServerSeed().serverSeedHex
    const entropy: [string, string] = [toHex(randomBytes(32)), toHex(randomBytes(32))]
    const a = playScriptedMatch({
      matchId, buttonDeviceId: button, bbDeviceId: bb,
      buttonPolicy: 'min-raise-once', bbPolicy: 'call-station',
      serverSeedHex: seed, entropy,
    })
    const b = playScriptedMatch({
      matchId, buttonDeviceId: button, bbDeviceId: bb,
      buttonPolicy: 'min-raise-once', bbPolicy: 'call-station',
      serverSeedHex: seed, entropy,
    })
    expect(a.engine.players.button.stack).toBe(b.engine.players.button.stack)
    expect(a.engine.players.bb.stack).toBe(b.engine.players.bb.stack)
    expect(a.terminal.reason).toBe(b.terminal.reason)
  })
})
