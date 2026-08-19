import { describe, expect, it } from 'vitest'
import { PokerEngine } from '@agent-colosseum/poker'
import { uuidv7 } from '@agent-colosseum/protocol'
import { deriveHandDeck, commitServerSeed, randomBytes, toHex } from '@agent-colosseum/crypto'
import { ArenaAgentRunner, type AgentHandleLike, type AgentLike } from './agent-runner.ts'
import { extractDecision } from './parse-decision.ts'
import { handleArenaRpc } from './rpc.ts'
import { ArenaRuntime } from './runtime.ts'
import { ArenaLlmAdapter } from './llm-adapter.ts'
import { assertCompatible, IncompatibleDshError } from './compat.ts'

function scriptAgent(outputs: string[]): { handle: AgentHandleLike; followed: number[] } {
  const followed: number[] = []
  let cursor = 0
  const agent: AgentLike = {
    ctx: {
      tools: {
        presentAs: () => () => undefined,
        restrict: () => () => undefined,
      },
      systemPrompt: {
        section: () => () => undefined,
        suppressRuntimeContext: () => () => undefined,
      },
    },
    followup() {
      followed.push(Date.now())
    },
    async whenIdle() {},
  }
  return {
    followed,
    handle: {
      agent,
      async dispose() {
        followed.push(-1)
      },
    },
    // expose outputs via waitForOutput
    outputs,
    cursor,
  } as never
}

describe('parse decision', () => {
  it('reads JSON and rejects extra prose without an object', () => {
    expect(extractDecision('{"action":"check","publicRationale":"ok"}').action).toBe('check')
    expect(() => extractDecision('I fold')).toThrow()
  })
})

describe('agent runner', () => {
  it('repairs once then auto-checks, and dispose is awaited', async () => {
    const outputs = ['not-json', '{"action":"check","publicRationale":"fixed"}']
    let n = 0
    const created: AgentHandleLike[] = []
    const runner = new ArenaAgentRunner({
      agents: {
        async create({ setup }) {
          const fake = scriptAgent(outputs)
          await setup?.(fake.handle.agent.ctx)
          created.push(fake.handle)
          return fake.handle
        },
      },
      async waitForOutput() {
        const text = outputs[n] ?? ''
        n += 1
        return text
      },
    })
    await runner.createContestant({ key: 'p1', provider: 'script', model: 'a' })
    const matchId = uuidv7()
    const engine = new PokerEngine({
      matchId,
      buttonDeviceId: uuidv7(),
      bbDeviceId: uuidv7(),
    })
    const seed = commitServerSeed()
    engine.startHand(deriveHandDeck({
      matchId,
      handNo: 1,
      serverSeedHex: seed.serverSeedHex,
      playerEntropy: [toHex(randomBytes(32)), toHex(randomBytes(32))],
    }))
    engine.apply('button', 'call')
    const result = await runner.decide({
      key: 'p1',
      snapshot: engine.snapshot('bb'),
      seat: 'bb',
      hole: engine.holes.bb!,
    })
    expect(result.decision.action).toBe('check')
    expect(result.followedUpAt).toBeLessThanOrEqual(result.idleAt)
    let disposed = false
    created[0]!.dispose = async () => { disposed = true }
    await runner.dispose('p1')
    expect(disposed).toBe(true)
  })

  it('faults to fold when a second output is illegal', async () => {
    const runner = new ArenaAgentRunner({
      agents: {
        async create() {
          return scriptAgent([]).handle
        },
      },
      async waitForOutput() {
        return '{"action":"raise"}'
      },
    })
    await runner.createContestant({ key: 'p1', provider: 'script', model: 'a' })
    const matchId = uuidv7()
    const engine = new PokerEngine({
      matchId,
      buttonDeviceId: uuidv7(),
      bbDeviceId: uuidv7(),
    })
    engine.startHand(deriveHandDeck({
      matchId,
      handNo: 1,
      serverSeedHex: commitServerSeed().serverSeedHex,
      playerEntropy: [toHex(randomBytes(32)), toHex(randomBytes(32))],
    }))
    const result = await runner.decide({
      key: 'p1',
      snapshot: engine.snapshot('button'),
      seat: 'button',
      hole: engine.holes.button!,
    })
    expect(result.fault).toBe('agent_fault')
    expect(result.decision.action).toBe('fold')
  })
})

describe('compat', () => {
  it('refuses unverified versions', () => {
    const previous = process.env.DSH_VERSION
    process.env.DSH_VERSION = '0.2.0-rc.0'
    expect(() => assertCompatible(false)).toThrow(IncompatibleDshError)
    expect(assertCompatible(true)).toBe('0.2.0-rc.0')
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
  })
})

describe('rpc + adapter', () => {
  it('bootstraps, plays a scripted local match, and lists grants on the adapter', async () => {
    process.env.DSH_VERSION = '0.1.0-rc.7'
    const runtime = new ArenaRuntime(
      { async create() { return scriptAgent([]).handle } },
      { serverUrl: '', inviteCode: '', allowUnverifiedDsh: false },
      async () => [{ provider: 'script', model: 'script-a', name: 'script-a', allowedForStake: true }],
    )
    const boot = await handleArenaRpc(runtime, 'bootstrap', {})
    expect(boot.ok).toBe(true)
    const ack = await handleArenaRpc(runtime, 'privacy.ack', {})
    expect(ack.ok).toBe(true)
    const local = await handleArenaRpc(runtime, 'match.local.start', {
      left: { provider: 'script', model: 'script-a' },
      right: { provider: 'script', model: 'script-b' },
    })
    expect(local.ok).toBe(true)
    if (local.ok) {
      const state = local.value as { view: string }
      expect(state.view).toBe('result')
    }
    runtime.setGrants([{
      grantId: uuidv7(),
      ownerDeviceId: uuidv7(),
      winnerDeviceId: runtime.deviceId,
      model: 'script-a',
      provider: 'script',
      callsRemaining: 10,
      onlineMsRemaining: 1000,
      ownerOnline: true,
      status: 'active',
      version: 1,
    }])
    const adapter = new ArenaLlmAdapter(() => runtime.grants, async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const models = await adapter.listModels('agent-colosseum')
    expect(models).toHaveLength(1)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'agent-colosseum',
      model: models[0]!.id,
      messages: [{ role: 'user', content: 'hi' }],
    })) chunks.push(chunk)
    expect(chunks.at(-1)?.type).toBe('finish')
  })
})
