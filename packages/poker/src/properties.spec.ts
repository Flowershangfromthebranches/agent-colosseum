import { describe, expect, it } from 'vitest'
import { commitServerSeed, deriveHandDeck } from '@agent-colosseum/crypto'
import { STARTING_STACK, uuidv7 } from '@agent-colosseum/protocol'
import { PokerEngine } from './engine.ts'
import { playScriptedMatch, randomEntropyPair } from './local-match.ts'
import { scriptDecide, type ScriptKind } from './script-policy.ts'

const POLICIES: ScriptKind[] = ['check-fold', 'call-station', 'min-raise-once']

describe('script policy', () => {
  it('covers fold and min-raise branches', () => {
    expect(scriptDecide('call-station', [{ action: 'fold' }], 1).action).toBe('fold')
    expect(scriptDecide('min-raise-once', [{ action: 'raise', minRaiseTo: 4 }], 1).action).toBe('raise')
    expect(scriptDecide('min-raise-once', [{ action: 'fold' }], 2).action).toBe('fold')
  })
})

describe('properties', () => {
  it('conserves 160 chips across random scripted matches', () => {
    for (let i = 0; i < 25; i++) {
      const result = playScriptedMatch({
        matchId: uuidv7(),
        deviceA: uuidv7(),
        deviceB: uuidv7(),
        policyA: POLICIES[i % 3]!,
        policyB: POLICIES[(i + 1) % 3]!,
        serverSeedHex: commitServerSeed().serverSeedHex,
        entropy: randomEntropyPair(),
      })
      expect(result.engine.totalChips()).toBe(STARTING_STACK * 2)
      expect(result.engine.state.terminal).toBeTruthy()
    }
  })

  it('never deals duplicate cards including burns', () => {
    const matchId = uuidv7()
    const seed = commitServerSeed().serverSeedHex
    const entropy = randomEntropyPair()
    const cards = deriveHandDeck({ matchId, handNo: 1, serverSeedHex: seed, playerEntropy: entropy })
    const engine = PokerEngine.create({
      matchId, deviceA: uuidv7(), deviceB: uuidv7(), deck: cards,
    })
    engine.startHand(cards)
    while (engine.state.toAct && !engine.state.terminal) {
      const decision = scriptDecide('call-station', engine.legalActions(), engine.state.handNo)
      engine.apply(engine.state.toAct, decision.action, decision.raiseTo)
    }
    const holes = [...engine.state.holes.A!, ...engine.state.holes.B!]
    const used = [...holes, ...engine.state.board]
    expect(new Set(used).size).toBe(used.length)
    expect(new Set(cards).size).toBe(52)
  })
})
