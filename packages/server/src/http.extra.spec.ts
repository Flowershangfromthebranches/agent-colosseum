import { describe, expect, it } from 'vitest'
import { generateDeviceKeypair, signUtf8 } from '@agent-colosseum/crypto'
import { PROTOCOL_VERSION, newMessageId } from '@agent-colosseum/protocol'
import { ArenaService } from './arena.ts'
import { buildServer, pingStore } from './http.ts'
import { sha256Hex } from './hash.ts'
import { MemoryStore } from './store.ts'

const INVITE = 'INVITECODE12ABCD'

function frame(type: string, payload: unknown) {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageId: newMessageId(),
    sentAt: Date.now(),
    type,
    payload,
  })
}

describe('http extras', () => {
  it('serves healthz and metrics', async () => {
    const arena = new ArenaService(new MemoryStore(), {
      host: '127.0.0.1', port: 0, databaseUrl: '', redisUrl: '',
      inviteHashes: new Map(), providerAllowlist: [], publicBaseUrl: '',
    })
    const app = await buildServer(arena, arena.config, { redisPing: async () => true })
    const health = await app.inject({ method: 'GET', url: '/healthz' })
    expect(health.json().ok).toBe(true)
    const metrics = await app.inject({ method: 'GET', url: '/metrics' })
    expect(metrics.body).toMatch(/arena_up/)
    expect(await pingStore(arena.store)).toBe(true)
    const unread = await buildServer(arena, arena.config)
    const ready = await unread.inject({ method: 'GET', url: '/readyz' })
    expect(ready.statusCode).toBe(503)
    await unread.close()
    await app.close()
  })

  it('authenticates a websocket and rejects unauthenticated frames', async () => {
    const store = new MemoryStore()
    await store.seedInvite(sha256Hex(INVITE), 4)
    const arena = new ArenaService(store, {
      host: '127.0.0.1', port: 0, databaseUrl: '', redisUrl: '',
      inviteHashes: new Map(), providerAllowlist: ['openai-compatible'], publicBaseUrl: '',
    })
    const app = await buildServer(arena, arena.config, { redisPing: async () => true })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`)
    const messages: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('ws error')))
    })
    ws.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    })
    ws.send(frame('session.heartbeat', { at: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(messages.some((item) => item.type === 'error')).toBe(true)
    const keys = generateDeviceKeypair()
    ws.send(frame('auth.hello', {
      inviteCode: INVITE,
      ed25519PublicKey: keys.ed25519PublicKey,
      x25519PublicKey: keys.x25519PublicKey,
    }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const challenge = messages.find((item) => item.type === 'auth.challenge')
    expect(challenge).toBeTruthy()
    const nonce = String((challenge!.payload as { nonce: string }).nonce)
    ws.send(frame('auth.challenge_response', {
      nonce,
      signature: signUtf8(keys.ed25519PrivateKey, nonce),
    }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(messages.some((item) => item.type === 'auth.session')).toBe(true)
    ws.send(frame('session.heartbeat', { at: Date.now() }))
    ws.send('{')
    await new Promise((resolve) => setTimeout(resolve, 50))
    ws.close()
    await app.close()
  })
})
