import { deriveHandDeck, randomBytes, toHex } from '@agent-colosseum/crypto'
import { MAX_HANDS } from '@agent-colosseum/protocol'
import { PokerEngine } from './engine.ts'
import { scriptDecide, type ScriptKind } from './script-policy.ts'

export function playScriptedMatch(input: {
  matchId: string
  deviceA: string
  deviceB: string
  policyA?: ScriptKind
  policyB?: ScriptKind
  serverSeedHex: string
  entropy: [string, string]
  onSnapshot?: (engine: PokerEngine) => void
}): { engine: PokerEngine } {
  const firstDeck = deriveHandDeck({
    matchId: input.matchId,
    handNo: 1,
    serverSeedHex: input.serverSeedHex,
    playerEntropy: input.entropy,
  })
  const engine = PokerEngine.create({
    matchId: input.matchId,
    deviceA: input.deviceA,
    deviceB: input.deviceB,
    deck: firstDeck,
  })
  while (!engine.state.terminal) {
    const deck = deriveHandDeck({
      matchId: input.matchId,
      handNo: engine.state.handNo + 1,
      serverSeedHex: input.serverSeedHex,
      playerEntropy: input.entropy,
    })
    engine.startHand(deck)
    input.onSnapshot?.(engine)
    while (engine.state.street !== 'complete' && !engine.state.terminal && engine.state.toAct) {
      const seat = engine.state.toAct
      const policy = seat === 'A' ? (input.policyA ?? 'check-fold') : (input.policyB ?? 'call-station')
      const decision = scriptDecide(policy, engine.legalActions(), engine.state.handNo)
      engine.apply(seat, decision.action, decision.raiseTo, decision.publicRationale)
      input.onSnapshot?.(engine)
    }
    if (engine.state.handNo >= MAX_HANDS && !engine.state.terminal && engine.state.players.A.stack === engine.state.players.B.stack) {
      continue
    }
    engine.maybeFinishMatch()
  }
  return { engine }
}

export function randomEntropyPair(): [string, string] {
  return [toHex(randomBytes(32)), toHex(randomBytes(32))]
}
