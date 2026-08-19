import { commitServerSeed, deriveHandDeck, randomBytes, toHex } from '@agent-colosseum/crypto'
import { playScriptedMatch, PokerEngine } from '@agent-colosseum/poker'
import { MAX_HANDS, uuidv7 } from '@agent-colosseum/protocol'
import { ArenaAgentRunner } from './agent-runner.ts'
import type { SnapshotStore } from './snapshot-store.ts'

export async function runLocalMatch(input: {
  store: SnapshotStore
  runner: ArenaAgentRunner
  deviceA: string
  left: { provider: string; model: string }
  right: { provider: string; model: string }
  signal?: AbortSignal
}): Promise<void> {
  const matchId = uuidv7()
  const seed = commitServerSeed()
  const entropy: [string, string] = [toHex(randomBytes(32)), toHex(randomBytes(32))]
  const deviceB = uuidv7()

  if (input.left.provider === 'script' && input.right.provider === 'script') {
    const played = playScriptedMatch({
      matchId,
      deviceA: input.deviceA,
      deviceB,
      serverSeedHex: seed.serverSeedHex,
      entropy,
      onSnapshot: (engine) => {
        input.store.patch({
          view: engine.state.terminal ? 'result' : 'table',
          match: engine.snapshot() as unknown as Record<string, unknown>,
          result: engine.state.terminal
            ? { ...engine.state.terminal.winnerDeviceId ? { winner: engine.state.terminal.winnerDeviceId } : {}, reason: engine.state.terminal.reason }
            : undefined,
        })
      },
    })
    input.store.patch({
      view: 'result',
      match: played.engine.snapshot() as unknown as Record<string, unknown>,
      result: {
        ...played.engine.state.terminal?.winnerDeviceId ? { winner: played.engine.state.terminal.winnerDeviceId } : {},
        reason: played.engine.state.terminal?.reason,
      },
    })
    return
  }

  await input.runner.createContestant({ key: 'A', ...input.left })
  await input.runner.createContestant({ key: 'B', ...input.right })
  const engine = PokerEngine.create({
    matchId,
    deviceA: input.deviceA,
    deviceB,
    deck: deriveHandDeck({ matchId, handNo: 1, serverSeedHex: seed.serverSeedHex, playerEntropy: entropy }),
  })
  try {
    while (!engine.state.terminal && !input.signal?.aborted) {
      engine.startHand(deriveHandDeck({
        matchId,
        handNo: engine.state.handNo + 1,
        serverSeedHex: seed.serverSeedHex,
        playerEntropy: entropy,
      }))
      publish(input.store, engine)
      while (engine.state.street !== 'complete' && !engine.state.terminal && engine.state.toAct && !input.signal?.aborted) {
        const seat = engine.state.toAct
        const hole = engine.state.holes[seat]!
        const decided = await input.runner.decide({
          key: seat,
          snapshot: engine.snapshot(seat),
          seat,
          hole,
        })
        engine.apply(seat, decided.decision.action, decided.decision.raiseTo, decided.decision.publicRationale, decided.fault)
        publish(input.store, engine)
      }
      if (engine.state.handNo >= MAX_HANDS && !engine.state.terminal && engine.state.players.A.stack === engine.state.players.B.stack) continue
      engine.maybeFinishMatch()
    }
    publish(input.store, engine)
  } finally {
    await input.runner.dispose()
  }
}

function publish(store: SnapshotStore, engine: PokerEngine): void {
  store.patch({
    view: engine.state.terminal ? 'result' : 'table',
    match: engine.snapshot() as unknown as Record<string, unknown>,
    lastActions: engine.state.lastActions,
    result: engine.state.terminal
      ? { ...engine.state.terminal.winnerDeviceId ? { winner: engine.state.terminal.winnerDeviceId } : {}, reason: engine.state.terminal.reason }
      : undefined,
  })
}
