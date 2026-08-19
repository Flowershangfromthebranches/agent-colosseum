import { describe, expect, it } from 'vitest'
import { apply, Config } from './index.ts'

process.env.DSH_VERSION = '0.1.0-rc.7'

describe('host apply', () => {
  it('registers the grant adapter and connection rpc', async () => {
    const adapters: string[][] = []
    let rpcHandler: ((endpoint: string, payload: unknown) => Promise<unknown>) | undefined
    let replaced = 0
    const ctx = {
      llm: {
        registerAdapter(providers: string[]) {
          adapters.push(providers)
          const handle = Object.assign(() => undefined, { replace() { replaced += 1 } })
          return handle
        },
        listProviders: () => [
          { id: 'openai-compatible', name: 'Local' },
          { id: 'script', name: 'Script' },
          { id: 'broken', name: 'Broken' },
          { id: 'agent-colosseum', name: 'Grant' },
        ],
        async listModels(provider: string) {
          if (provider === 'broken') throw new Error('nope')
          return [{ id: 'm', name: 'M' }]
        },
        async * stream() {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      agents: {
        async create() {
          return { agent: { ctx: {}, followup() {}, async whenIdle() {} }, async dispose() {} }
        },
      },
      connection: {
        rpc: {
          handle(_channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>) {
            rpcHandler = handler
            return async () => undefined
          },
        },
      },
      credentials: {
        async resolve() { return undefined },
        async set() {},
      },
      effect(fn: () => () => void) {
        const dispose = fn()
        return dispose
      },
      inject(_deps: string[], callback: (inner: typeof ctx) => void) {
        callback(ctx)
      },
    }
    let dispose: (() => void) | undefined
    ctx.effect = (fn: () => () => void) => {
      dispose = fn()
      return dispose
    }
    apply(ctx as never, { serverUrl: '', inviteCode: '', allowUnverifiedDsh: true })
    expect(adapters[0]).toContain('agent-colosseum')
    expect(rpcHandler).toBeTypeOf('function')
    const boot = await rpcHandler!('bootstrap', {})
    expect(boot).toMatchObject({ ok: true })
    const validated = Config['~standard'].validate({ serverUrl: 'wss://x' })
    expect(validated.value.serverUrl).toBe('wss://x')
    expect(Config['~standard'].validate(undefined).value.inviteCode).toBe('')
    dispose?.()
  })

  it('applies when connection is not yet present', () => {
    const ctx = {
      llm: {
        registerAdapter() {
          return Object.assign(() => undefined, { replace() {} })
        },
        listProviders: () => [],
        async listModels() { return [] },
        async * stream() {},
      },
      agents: { async create() { return { agent: { ctx: {}, followup() {}, async whenIdle() {} }, async dispose() {} } } },
      credentials: { async resolve() { return undefined }, async set() {} },
      effect(fn: () => () => void) {
        return fn()
      },
      inject() {},
    }
    expect(() => apply(ctx as never, { serverUrl: '', inviteCode: '', allowUnverifiedDsh: true })).not.toThrow()
  })
})
