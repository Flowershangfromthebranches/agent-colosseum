import { describe, expect, it } from 'vitest'
import { commitServerSeed, deriveHandDeck, randomBytes, toHex } from '@agent-colosseum/crypto'
import { STARTING_STACK, uuidv7 } from '@agent-colosseum/protocol'
import { PokerEngine } from './engine.ts'
import { playScriptedMatch } from './local-match.ts'
import { scriptDecide, type ScriptKind } from './script-policy.ts'

const POLICIES: ScriptKind[] = ['check-fold', 'call-station', 'min-raise-once']

describe('properties', () => {
  it('conserves 160 chips across random scripted matches', () => {
    for (let i = 0; i < 25; i++) {
      const result = playScriptedMatch({
        matchId: uuidv7(),
        buttonDeviceId: uuidv7(),
        bbDeviceId: uuidv7(),
        buttonPolicy: POLICIES[i % 3]!,
        bbPolicy: POLICIES[(i + 1) % 3]!,
      })
      expect(result.engine.players.button.stack + result.engine.players.bb.stack).toBe(STARTING_STACK * 2)
      expect(result.terminal).toBeTruthy()
      expect(result.engine.terminal).toBe(result.terminal)
    }
  })

  it('never deals duplicate cards and replays a hand from the same seed', () => {
    const matchId = uuidv7()
    const seed = commitServerSeed().serverSeedHex
    const entropy: [string, string] = [toHex(randomBytes(32)), toHex(randomBytes(32))]
    const deck = deriveHandDeck({ matchId, handNo: 1, serverSeedHex: seed, playerEntropy: entropy })
    expect(new Set(deck).size).toBe(52)
    const a = new PokerEngine({ matchId, buttonDeviceId: uuidv7(), bbDeviceId: uuidv7() })
    const b = new PokerEngine({ matchId, buttonDeviceId: a.buttonDeviceId, bbDeviceId: a.bbDeviceId })
    a.startHand(deck)
    b.startHand(deck)
    while (a.toAct && !a.terminal) {
      const decision = scriptDecide('call-station', a.legalActions(), a.handNo)
      a.apply(a.toAct, decision.action, decision.raiseTo, decision.publicRationale)
      b.apply(b.toAct!, decision.action, decision.raiseTo, decision.publicRationale)
    }
    expect(a.snapshot()).toEqual(b.snapshot())
    const live = [...a.holes.button!, ...a.holes.bb!, ...a.board]
    expect(new Set(live).size).toBe(9)
  })
})
