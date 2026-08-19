import { describe, expect, it } from 'vitest'
import { commitServerSeed, deriveHandDeck, randomBytes, toHex } from '@agent-colosseum/crypto'
import { PokerEngine } from '@agent-colosseum/poker'
import { uuidv7 } from '@agent-colosseum/protocol'
import { ArenaAgentRunner, type AgentHandleLike, type AgentLike } from './agent-runner.ts'
import { extractDecision } from './parse-decision.ts'
import { handleArenaRpc } from './rpc.ts'
import { ArenaRuntime } from './runtime.ts'
import { ArenaLlmAdapter } from './llm-adapter.ts'
import { assertCompatible, IncompatibleDshError } from './compat.ts'

function scriptHandle(outputs: Array<{ seq: number; text: string }>): AgentHandleLike {
  const events: NonNullable<AgentLike['session']>['events'] = []
  const agent: AgentLike = {
    session: { events },
    ctx: {
      tools: { presentAs: () => () => undefined, restrict: () => () => undefined },
      systemPrompt: { section: () => () => undefined, suppressRuntimeContext: () => () => undefined },
    },
    followup() {
      const next = outputs.shift()
      if (next) events.push({ type: 'assistant/message', seq: next.seq, data: { message: { content: [{ type: 'text', text: next.text }] } } })
    },
    async whenIdle() {},
    cancel() {},
  }
  return { agent, async dispose() {} }
}

describe('parse', () => {
  it('reads JSON and ignores reasoning-shaped blocks', () => {
    expect(extractDecision('{"action":"check","publicRationale":"ok"}').action).toBe('check')
    expect(() => extractDecision('I fold')).toThrow()
  })
})

describe('agent runner', () => {
  it('uses the followup interval and disposes after idle', async () => {
    process.env.DSH_VERSION = '0.1.0-rc.7'
    let disposed = false
    const followed: unknown[] = []
    const handle = scriptHandle([
      { seq: 1, text: 'not-json' },
      { seq: 2, text: '{"action":"check","publicRationale":"fixed"}' },
    ])
    const innerFollow = handle.agent.followup.bind(handle.agent)
    handle.agent.followup = (message) => {
      followed.push(message)
      innerFollow(message)
    }
    handle.dispose = async () => { disposed = true }
    const runner = new ArenaAgentRunner({
      async create({ setup }) {
        await setup?.(handle.agent.ctx)
        return handle
      },
    })
    await runner.createContestant({ key: 'A', provider: 'openai-compatible', model: 'm' })
    const engine = PokerEngine.create({
      matchId: uuidv7(),
      deviceA: uuidv7(),
      deviceB: uuidv7(),
      deck: deriveHandDeck({
        matchId: uuidv7(),
        handNo: 1,
        serverSeedHex: commitServerSeed().serverSeedHex,
        playerEntropy: [toHex(randomBytes(32)), toHex(randomBytes(32))],
      }),
    })
    engine.startHand(engine.state.deck)
    engine.apply('A', 'call')
    const result = await runner.decide({
      key: 'A',
      snapshot: engine.snapshot('B'),
      seat: 'B',
      hole: engine.state.holes.B!,
    })
    expect(result.decision.action).toBe('check')
    expect(followed[0]).toMatchObject({ role: 'user', content: [{ type: 'text' }] })
    await runner.dispose('A')
    expect(disposed).toBe(true)
  })
})

describe('compat', () => {
  it('refuses unverified versions', () => {
    process.env.DSH_VERSION = '0.2.0-rc.0'
    expect(() => assertCompatible(false)).toThrow(IncompatibleDshError)
    expect(assertCompatible(true)).toBe('0.2.0-rc.0')
    process.env.DSH_VERSION = '0.1.0-rc.7'
  })
})

describe('rpc + local match', () => {
  it('plays a local scripted match through RPC', async () => {
    process.env.DSH_VERSION = '0.1.0-rc.7'
    const runtime = new ArenaRuntime(
      { async create() { return scriptHandle([] ) } },
      { serverUrl: '', inviteCode: '', allowUnverifiedDsh: false },
      async () => [{ provider: 'openai-compatible', model: 'local', name: 'local', allowedForStake: true }],
    )
    const boot = await handleArenaRpc(runtime, 'bootstrap', {})
    expect(boot.ok).toBe(true)
    await handleArenaRpc(runtime, 'privacy.ack', {})
    const local = await handleArenaRpc(runtime, 'match.local.start', {
      left: { provider: 'script', model: 'a' },
      right: { provider: 'script', model: 'b' },
    })
    if (!local.ok) throw new Error(local.error.message)
    expect(local.ok).toBe(true)
    if (local.ok) expect((local.value as { view: string }).view).toBe('result')
    runtime.setGrants([{
      grantId: uuidv7(), ownerDeviceId: uuidv7(), winnerDeviceId: uuidv7(),
      model: 'local', provider: 'openai-compatible', callsRemaining: 10, activeConcurrency: 0,
      onlineMsRemaining: 1000, ownerOnline: true, status: 'active', statusReason: 'active', version: 1,
    }])
    const adapter = new ArenaLlmAdapter(() => runtime.store.snapshot.grants as never, async function* () {
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const models = await adapter.listModels('agent-colosseum')
    expect(models).toHaveLength(1)
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'agent-colosseum', model: models[0]!.id, messages: ['hi'] })) chunks.push(chunk)
    expect(chunks.at(-1)?.type).toBe('finish')
  })
})
