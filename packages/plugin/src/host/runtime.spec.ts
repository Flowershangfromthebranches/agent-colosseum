import { describe, expect, it, vi } from 'vitest'
import { generateDeviceKeypair } from '@agent-colosseum/crypto'
import { newDeviceId, newGrantId } from '@agent-colosseum/protocol'
import { RelayController, MemoryStore } from '@agent-colosseum/server'
import { handleArenaRpc } from './rpc.ts'
import { ArenaRuntime } from './runtime.ts'
import type { StreamChunk } from './llm-adapter.ts'
import { MATCH_SYSTEM_PROMPT } from './prompt.ts'
import { textFromAssistantMessage } from './parse-decision.ts'
import { createUserMessage } from './user-message.ts'

process.env.DSH_VERSION = '0.1.0-rc.7'

function runtime() {
  return new ArenaRuntime(
    {
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
    },
    { serverUrl: '', inviteCode: '', allowUnverifiedDsh: false },
    async () => [
      { provider: 'script', model: 'a', name: 'script', allowedForStake: false },
      { provider: 'openai-compatible', model: 'local', name: 'local', allowedForStake: true },
    ],
  )
}

describe('runtime rpc and grant stream', () => {
  it('walks privacy, lobby, models, room rpcs and local script match', async () => {
    const rt = runtime()
    expect((await handleArenaRpc(rt, 'bootstrap', {})).ok).toBe(true)
    expect(rt.store.snapshot.models.every((item) => item.provider !== 'script')).toBe(true)
    expect((await handleArenaRpc(rt, 'privacy.ack', {})).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'models.list', {})).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'room.create', { provider: 'openai-compatible', model: 'local' })).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'room.join', { roomCode: 'ABC234', provider: 'openai-compatible', model: 'local' })).ok).toBe(true)
    const accept = await handleArenaRpc(rt, 'room.accept', {})
    expect(accept.ok).toBe(false)
    expect((await handleArenaRpc(rt, 'room.leave', {})).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'match.snapshot', {})).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'grants.list', {})).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'grants.stream', { grantId: 'missing' })).ok).toBe(false)
    expect((await handleArenaRpc(rt, 'events.poll', { cursor: 0, timeoutMs: 1 })).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'nope', {})).ok).toBe(false)
    const local = await handleArenaRpc(rt, 'match.local.start', {
      left: { provider: 'script', model: 'a' },
      right: { provider: 'script', model: 'b' },
    })
    expect(local.ok).toBe(true)
    expect((await handleArenaRpc(rt, 'match.local.cancel', {})).ok).toBe(true)
    rt.store.patch({ deviceId: '11111111-1111-7111-8111-111111111111' })
    expect((await handleArenaRpc(rt, 'match.local.start', {
      left: { provider: 'script', model: 'a' },
      right: { provider: 'script', model: 'b' },
    })).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'match.local.start', {
      left: { provider: 'script', model: 'a' },
      right: { provider: 'script', model: 'b' },
    })).ok).toBe(true)
    rt.store.patch({ roomId: '11111111-1111-7111-8111-111111111111', models: [{ provider: 'openai-compatible', model: 'local', name: 'local', allowedForStake: true }] })
    expect((await handleArenaRpc(rt, 'room.accept', {})).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'room.leave', {})).ok).toBe(true)
    expect((await handleArenaRpc(rt, 'events.poll', { cursor: rt.store.version, timeoutMs: 1 })).ok).toBe(true)
    expect(MATCH_SYSTEM_PROMPT).toMatch(/JSON/)
    expect(textFromAssistantMessage({})).toBe('')
    expect(createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'test' } }).source.kind).toBe('test')
  })

  it('streams a grant through the bound owner llm', async () => {
    const rt = runtime()
    const store = new MemoryStore()
    const owner = { deviceId: newDeviceId(), keys: generateDeviceKeypair() }
    const winner = newDeviceId()
    const grant = {
      grantId: newGrantId(), ownerDeviceId: owner.deviceId, winnerDeviceId: winner,
      model: 'owned', provider: 'openai-compatible', callsRemaining: 2, activeConcurrency: 0,
      onlineMsRemaining: 1000, ownerOnline: true, status: 'active' as const, statusReason: 'active' as const, version: 1,
    }
    await store.saveGrant({ ...grant, stakeId: 's', lastOnlineTickAt: null })
    rt.store.patch({ deviceId: winner })
    rt.bindOwner(
      {
        async * stream(): AsyncIterable<StreamChunk> {
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      owner,
      new RelayController(store),
    )
    const chunks: StreamChunk[] = []
    for await (const chunk of rt.streamGrant({ provider: 'attacker', model: 'x', messages: ['hi'] }, grant)) {
      chunks.push(chunk)
    }
    expect(chunks.at(-1)?.type).toBe('finish')
    rt.setGrants([grant])
    const redeemed = await handleArenaRpc(rt, 'grants.stream', { grantId: grant.grantId, prompt: 'hello from winner' })
    expect(redeemed.ok).toBe(true)
    expect((redeemed as { value: { view?: string; relay?: { status?: string } } }).value.view).toBe('relay')
    await rt.dispose()
  })

  it('surfaces relay errors and refuses a disconnected winner path', async () => {
    const rt = runtime()
    const grant = {
      grantId: newGrantId(), ownerDeviceId: newDeviceId(), winnerDeviceId: newDeviceId(),
      model: 'owned', provider: 'openai-compatible', callsRemaining: 1, activeConcurrency: 0,
      onlineMsRemaining: 1, ownerOnline: true, status: 'active' as const, statusReason: 'active' as const, version: 1,
    }
    await expect(async () => {
      for await (const _ of rt.streamGrant({ provider: 'p', model: 'm', messages: [] }, grant)) { /* drain */ }
    }).rejects.toMatchObject({ code: 'RELAY_DISCONNECTED' })

    rt.bindOwner(
      { async * stream() { yield { type: 'finish' as const, reason: { kind: 'error' as const } }; throw new Error('boom') } },
      { deviceId: grant.ownerDeviceId, keys: generateDeviceKeypair() },
      {
        async reserve() { return { grant } },
        async preflight() { return {} },
        async start() { return grant },
        async terminal() { return {} },
      },
    )
    await expect(async () => {
      for await (const _ of rt.streamGrant({ provider: 'p', model: 'm', messages: ['x'] }, grant)) { /* drain */ }
    }).rejects.toThrow(/boom/)
    expect(rt.store.snapshot.relay?.status).toBe('error')
  })

  it('starts a connection when a server url is set', async () => {
    vi.stubGlobal('WebSocket', function WebSocket() {
      return {
        readyState: 1,
        OPEN: 1,
        addEventListener() {},
        send() {},
        close() {},
      }
    })
    const rt = new ArenaRuntime(
      { async create() { return { agent: { ctx: {}, followup() {}, async whenIdle() {} }, async dispose() {} } } },
      { serverUrl: 'wss://example', inviteCode: '', allowUnverifiedDsh: true },
      async () => [],
    )
    await rt.start()
    expect(rt.connection).toBeTruthy()
    rt.connection?.stop()
    vi.unstubAllGlobals()
  })
})
