import { commitServerSeed, deriveHandDeck, randomBytes, toHex } from '@agent-colosseum/crypto'
import { MAX_HANDS } from '@agent-colosseum/protocol'
import { PokerEngine } from './engine.ts'
import { scriptDecide, type ScriptKind } from './script-policy.ts'
import type { MatchTerminal } from './types.ts'

export function playScriptedMatch(input: {
  matchId: string
  buttonDeviceId: string
  bbDeviceId: string
  buttonPolicy?: ScriptKind
  bbPolicy?: ScriptKind
  serverSeedHex?: string
  entropy?: [string, string]
}): { terminal: MatchTerminal; engine: PokerEngine; serverSeedHex: string } {
  const commit = input.serverSeedHex
    ? { serverSeedHex: input.serverSeedHex, commitment: '' }
    : commitServerSeed()
  const entropy = input.entropy ?? [toHex(randomBytes(32)), toHex(randomBytes(32))]
  const engine = new PokerEngine({
    matchId: input.matchId,
    buttonDeviceId: input.buttonDeviceId,
    bbDeviceId: input.bbDeviceId,
  })
  while (!engine.terminal) {
    const deck = deriveHandDeck({
      matchId: input.matchId,
      handNo: engine.handNo + 1,
      serverSeedHex: commit.serverSeedHex,
      playerEntropy: entropy,
    })
    engine.startHand(deck)
    while (engine.street !== 'complete' && !engine.terminal && engine.toAct) {
      const seat = engine.toAct
      const policy = seat === 'button' ? (input.buttonPolicy ?? 'check-fold') : (input.bbPolicy ?? 'call-station')
      const decision = scriptDecide(policy, engine.legalActions(), engine.handNo)
      engine.apply(seat, decision.action, decision.raiseTo, decision.publicRationale)
    }
    if (engine.handNo >= MAX_HANDS && !engine.terminal && engine.players.button.stack === engine.players.bb.stack) {
      continue
    }
    engine.maybeFinishMatch()
  }
  return { terminal: engine.terminal!, engine, serverSeedHex: commit.serverSeedHex }
}
