import { describe, expect, it } from 'vitest'
import { newGrantId, newDeviceId, PROVIDER_ID } from '@agent-colosseum/protocol'
import { ArenaLlmAdapter, type StreamChunk } from './llm-adapter.ts'

function grant(overrides: Record<string, unknown> = {}) {
  return {
    grantId: newGrantId(),
    ownerDeviceId: newDeviceId(),
    winnerDeviceId: newDeviceId(),
    model: 'm',
    provider: 'openai-compatible',
    callsRemaining: 3,
    activeConcurrency: 0,
    onlineMsRemaining: 1000,
    ownerOnline: true,
    status: 'active' as const,
    statusReason: 'active' as const,
    version: 1,
    ...overrides,
  }
}

async function collect(adapter: ArenaLlmAdapter, options: Parameters<ArenaLlmAdapter['stream']>[0]) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

describe('ArenaLlmAdapter', () => {
  it('lists only active grants and rejects offline/exhausted/oversize', async () => {
    const live = grant()
    const dead = grant({ status: 'exhausted', callsRemaining: 0 })
    const adapter = new ArenaLlmAdapter(
      () => [live, dead],
      async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    )
    expect(await adapter.listModels(PROVIDER_ID)).toHaveLength(1)
    expect((await adapter.resolveModel(PROVIDER_ID, live.grantId)).defaultMaxTokens).toBe(4096)
    expect(adapter.providerInfo(PROVIDER_ID).id).toBe(PROVIDER_ID)
    await expect(collect(adapter, { provider: 'nope', model: live.grantId, messages: [] }))
      .rejects.toMatchObject({ code: 'NO_ADAPTER' })
    const off = grant({ ownerOnline: false })
    const offline = new ArenaLlmAdapter(() => [off], async function* () {})
    expect((await collect(offline, { provider: PROVIDER_ID, model: off.grantId, messages: [] })).at(-1)?.reason)
      .toMatchObject({ failure: { code: 'OWNER_OFFLINE' } })
    const none = new ArenaLlmAdapter(() => [], async function* () {})
    expect((await collect(none, { provider: PROVIDER_ID, model: live.grantId, messages: [] })).at(-1)?.reason)
      .toMatchObject({ failure: { code: 'GRANT_UNAVAILABLE' } })
    const spent = grant({ callsRemaining: 0 })
    const empty = new ArenaLlmAdapter(() => [spent], async function* () {})
    expect((await collect(empty, { provider: PROVIDER_ID, model: spent.grantId, messages: [] })).at(-1)?.reason)
      .toMatchObject({ failure: { code: 'GRANT_EXHAUSTED' } })
    expect((await collect(adapter, { provider: PROVIDER_ID, model: live.grantId, messages: [], maxTokens: 5000 })).at(-1)?.reason)
      .toMatchObject({ failure: { code: 'MAX_TOKENS_EXCEEDED' } })
    expect((await collect(adapter, { provider: PROVIDER_ID, model: live.grantId, messages: ['x'.repeat(70_000)] })).at(-1)?.reason)
      .toMatchObject({ failure: { code: 'REQUEST_TOO_LARGE' } })
    expect((await adapter.resolveModel(PROVIDER_ID, 'missing')).name).toBe('missing')
  })
})
