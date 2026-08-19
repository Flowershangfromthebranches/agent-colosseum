import { describe, expect, it } from 'vitest'
import { generateDeviceKeypair, relayAad, sealJson, deriveSharedKey } from '@agent-colosseum/crypto'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  newDeviceId,
  newGrantId,
  newInferenceId,
  uuidv7,
} from '@agent-colosseum/protocol'
import { RelayController } from '@agent-colosseum/server'
import { MemoryStore } from '@agent-colosseum/server'
import { openWinnerRequest, streamGrantThroughOwner } from './grant-relay.ts'
import { createUserMessage } from './user-message.ts'
import type { StreamChunk } from './llm-adapter.ts'

function grant(owner: string, winner: string) {
  return {
    grantId: newGrantId(),
    ownerDeviceId: owner,
    winnerDeviceId: winner,
    model: 'owned-model',
    provider: 'openai-compatible',
    callsRemaining: 10,
    activeConcurrency: 0,
    onlineMsRemaining: 60_000,
    ownerOnline: true,
    status: 'active' as const,
    statusReason: 'active' as const,
    version: 1,
  }
}

async function* scriptChunks(): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'ok' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
  yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

describe('createUserMessage', () => {
  it('builds a DSH-shaped user message', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: 'hi' }] })
    expect(message.role).toBe('user')
    expect(message.content[0]?.text).toBe('hi')
    expect(message.id).toBeTruthy()
  })
})

describe('grant relay product path', () => {
  it('streams encrypted chunks, forces grant route, and deducts once on replay', async () => {
    const store = new MemoryStore()
    const ledger = new RelayController(store)
    const ownerKeys = generateDeviceKeypair()
    const winnerKeys = generateDeviceKeypair()
    const ownerId = newDeviceId()
    const winnerId = newDeviceId()
    const record = grant(ownerId, winnerId)
    await store.saveGrant({ ...record, stakeId: 's', lastOnlineTickAt: null })
    let routed: { provider?: string; model?: string } = {}
    const chunks = []
    for await (const chunk of streamGrantThroughOwner({
      grant: record,
      options: { provider: 'attacker', model: 'hijack', messages: [{ role: 'user', content: 'hi' }] },
      winner: { deviceId: winnerId, keys: winnerKeys },
      owner: { deviceId: ownerId, keys: ownerKeys },
      ownerLlm: {
        stream(options) {
          routed = options
          return scriptChunks()
        },
      },
      ledger,
      ownerOnline: true,
    })) chunks.push(chunk)
    expect(routed.provider).toBe('openai-compatible')
    expect(routed.model).toBe('owned-model')
    expect(chunks.at(-1)?.type).toBe('finish')
    const stored = await store.getGrant(record.grantId)
    expect(stored?.callsRemaining).toBe(9)
    const inference = [...store.inferences.values()][0]!
    const again = await ledger.start(record.grantId, inference.inferenceId)
    expect(again.callsRemaining).toBe(9)
  })

  it('consumes a started call when the winner aborts', async () => {
    const store = new MemoryStore()
    const ledger = new RelayController(store)
    const ownerKeys = generateDeviceKeypair()
    const winnerKeys = generateDeviceKeypair()
    const ownerId = newDeviceId()
    const winnerId = newDeviceId()
    const record = grant(ownerId, winnerId)
    await store.saveGrant({ ...record, stakeId: 's', lastOnlineTickAt: null })
    const abort = new AbortController()
    abort.abort()
    await expect(async () => {
      for await (const _ of streamGrantThroughOwner({
        grant: record,
        options: { provider: 'openai-compatible', model: 'owned-model', messages: ['x'], signal: abort.signal },
        winner: { deviceId: winnerId, keys: winnerKeys },
        owner: { deviceId: ownerId, keys: ownerKeys },
        ownerLlm: { stream: scriptChunks },
        ledger,
        ownerOnline: true,
      })) { /* drain */ }
    }).rejects.toThrow(/abort/)
    expect((await store.getGrant(record.grantId))?.callsRemaining).toBe(9)
  })

  it('rejects AAD direction swap when opening a winner box', () => {
    const owner = generateDeviceKeypair()
    const winner = generateDeviceKeypair()
    const grantId = uuidv7()
    const inferenceId = newInferenceId()
    const shared = deriveSharedKey(winner.x25519PrivateKey, owner.x25519PublicKey)
    const box = sealJson(shared, { messages: [] }, relayAad({
      grantId, inferenceId, seq: 0, direction: 'owner_to_winner',
    }))
    expect(() => openWinnerRequest({
      ownerPrivate: owner.x25519PrivateKey,
      winnerPublic: winner.x25519PublicKey,
      grantId,
      inferenceId,
      box,
    })).toThrow()
  })

  it('rejects a mismatched owner and covers abort/provider terminals', async () => {
    const store = new MemoryStore()
    const record = grant(newDeviceId(), newDeviceId())
    await store.saveGrant({ ...record, stakeId: 's', lastOnlineTickAt: null })
    await expect(async () => {
      for await (const _ of streamGrantThroughOwner({
        grant: record,
        options: { provider: 'openai-compatible', model: 'owned-model', messages: ['x'] },
        winner: { deviceId: record.winnerDeviceId, keys: generateDeviceKeypair() },
        owner: { deviceId: newDeviceId(), keys: generateDeviceKeypair() },
        ownerLlm: { stream: scriptChunks },
        ledger: new RelayController(store),
        ownerOnline: true,
      })) { /* drain */ }
    }).rejects.toThrow(/UNAUTHORIZED/)

    const live = grant(newDeviceId(), newDeviceId())
    await store.saveGrant({ ...live, stakeId: 's2', lastOnlineTickAt: null })
    const abort = new AbortController()
    await expect(async () => {
      for await (const _ of streamGrantThroughOwner({
        grant: live,
        options: { provider: 'openai-compatible', model: 'owned-model', messages: ['x'], signal: abort.signal },
        winner: { deviceId: live.winnerDeviceId, keys: generateDeviceKeypair() },
        owner: { deviceId: live.ownerDeviceId, keys: generateDeviceKeypair() },
        ownerLlm: {
          async * stream() {
            yield { type: 'text-delta', text: 'x' }
            abort.abort()
            throw new Error('provider')
          },
        },
        ledger: new RelayController(store),
        ownerOnline: true,
      })) { /* drain */ }
    }).rejects.toThrow(/provider/)

    const done = grant(newDeviceId(), newDeviceId())
    await store.saveGrant({ ...done, stakeId: 's3', lastOnlineTickAt: null })
    const late = new AbortController()
    const chunks = []
    for await (const chunk of streamGrantThroughOwner({
      grant: done,
      options: { provider: 'openai-compatible', model: 'owned-model', messages: ['x'], signal: late.signal },
      winner: { deviceId: done.winnerDeviceId, keys: generateDeviceKeypair() },
      owner: { deviceId: done.ownerDeviceId, keys: generateDeviceKeypair() },
      ownerLlm: {
        async * stream() {
          yield { type: 'text-delta', text: 'x' }
          late.abort()
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      ledger: new RelayController(store),
      ownerOnline: true,
    })) chunks.push(chunk)
    expect(chunks[0]?.type).toBe('text-delta')
  })

  it('refuses explicit maxTokens above 4096', async () => {
    const store = new MemoryStore()
    const ledger = new RelayController(store)
    const record = grant(newDeviceId(), newDeviceId())
    await store.saveGrant({ ...record, stakeId: 's', lastOnlineTickAt: null })
    await expect(async () => {
      for await (const _ of streamGrantThroughOwner({
        grant: record,
        options: {
          provider: 'openai-compatible',
          model: 'owned-model',
          messages: ['x'],
          maxTokens: DEFAULT_MAX_OUTPUT_TOKENS + 1,
        },
        winner: { deviceId: record.winnerDeviceId, keys: generateDeviceKeypair() },
        owner: { deviceId: record.ownerDeviceId, keys: generateDeviceKeypair() },
        ownerLlm: { stream: scriptChunks },
        ledger,
        ownerOnline: true,
      })) { /* drain */ }
    }).rejects.toThrow(/MAX_TOKENS/)
  })
})
