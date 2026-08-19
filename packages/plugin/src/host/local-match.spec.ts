import { describe, expect, it } from 'vitest'
import { uuidv7 } from '@agent-colosseum/protocol'
import { ArenaAgentRunner } from './agent-runner.ts'
import { runLocalMatch } from './local-match.ts'
import { SnapshotStore } from './snapshot-store.ts'

process.env.DSH_VERSION = '0.1.0-rc.7'

describe('local match driver', () => {
  it('runs two scripted agents until a result', async () => {
    const store = new SnapshotStore()
    const runner = new ArenaAgentRunner({
      async create() {
        return {
          agent: {
            ctx: {
              tools: { presentAs: () => () => undefined, restrict: () => () => undefined },
              systemPrompt: { section: () => () => undefined, suppressRuntimeContext: () => () => undefined },
            },
            followup() {},
            async whenIdle() {},
            session: { events: [] },
          },
          async dispose() {},
        }
      },
    })
    await runLocalMatch({
      store,
      runner,
      deviceA: uuidv7(),
      left: { provider: 'script', model: 'a' },
      right: { provider: 'script', model: 'b' },
    })
    expect(store.snapshot.view).toBe('result')
  })

  it('drives real contestants until abort', async () => {
    const store = new SnapshotStore()
    const abort = new AbortController()
    const runner = new ArenaAgentRunner({
      async create() {
        return {
          agent: {
            ctx: {
              tools: { presentAs: () => () => undefined, restrict: () => () => undefined },
              systemPrompt: { section: () => () => undefined, suppressRuntimeContext: () => () => undefined },
            },
            followup() {
              abort.abort()
            },
            async whenIdle() {},
            session: {
              events: [{
                type: 'assistant/message',
                seq: 1,
                data: { message: { content: [{ type: 'text', text: '{"action":"fold","publicRationale":"x"}' }] } },
              }],
            },
          },
          async dispose() {},
        }
      },
    })
    await runLocalMatch({
      store,
      runner,
      deviceA: uuidv7(),
      left: { provider: 'openai-compatible', model: 'a' },
      right: { provider: 'openai-compatible', model: 'b' },
      signal: abort.signal,
    })
    expect(['table', 'result', 'lobby']).toContain(store.snapshot.view)
  })
})
