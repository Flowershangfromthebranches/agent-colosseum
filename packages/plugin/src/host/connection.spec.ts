import { describe, expect, it, vi } from 'vitest'
import { generateDeviceKeypair } from '@agent-colosseum/crypto'
import { newGrantId, newInferenceId } from '@agent-colosseum/protocol'
import { SnapshotStore } from './snapshot-store.ts'
import { ArenaConnection } from './connection.ts'
import { sealWinnerRequest } from './grant-relay.ts'

class FakeSocket {
  readyState = 1
  OPEN = 1
  listeners: Record<string, Array<(event?: { data?: string }) => void>> = {}
  sent: string[] = []
  addEventListener(type: string, fn: (event?: { data?: string }) => void) {
    this.listeners[type] = [...(this.listeners[type] ?? []), fn]
  }
  send(data: string) { this.sent.push(data) }
  close() {
    this.readyState = 3
    for (const fn of this.listeners.close ?? []) fn()
  }
  emit(type: string, data?: string) {
    for (const fn of this.listeners[type] ?? []) fn(data === undefined ? undefined : { data })
  }
}

describe('ArenaConnection', () => {
  it('authenticates and updates snapshot from server frames', async () => {
    const sock = new FakeSocket()
    vi.stubGlobal('WebSocket', function WebSocket() { return sock })
    const store = new SnapshotStore()
    const conn = new ArenaConnection('', '', store, {
      async resolve() { return { value: JSON.stringify(generateDeviceKeypair()) } },
      async set() {},
    })
    await conn.start()
    sock.emit('open')
    expect(sock.sent.some((item) => item.includes('auth.hello'))).toBe(true)
    sock.emit('message', JSON.stringify({ type: 'auth.challenge', payload: { nonce: 'n1' } }))
    sock.emit('message', JSON.stringify({ type: 'auth.session', payload: { deviceId: '11111111-1111-7111-8111-111111111111' } }))
    expect(store.snapshot.connectionState).toBe('ready')
    sock.emit('message', JSON.stringify({ type: 'room.created', payload: { roomId: 'r', roomCode: 'ABC234' } }))
    expect(store.snapshot.view).toBe('room')
    sock.emit('message', JSON.stringify({ type: 'room.updated', payload: { roomId: 'r', roomCode: 'ABC234' } }))
    sock.emit('message', JSON.stringify({ type: 'match.private', payload: { handNo: 1 } }))
    sock.emit('message', JSON.stringify({ type: 'match.public', payload: { handNo: 1 } }))
    expect(store.snapshot.view).toBe('table')
    sock.emit('message', JSON.stringify({ type: 'match.settled', payload: { terminal: { reason: 'bust', winnerDeviceId: 'w' } } }))
    expect(store.snapshot.view).toBe('result')
    sock.emit('message', JSON.stringify({ type: 'grant.updated', payload: { grantId: 'g' } }))
    sock.emit('message', JSON.stringify({ type: 'relay.abort', payload: { grantId: 'g', inferenceId: 'i' } }))
    conn.stop()
    sock.close()
    vi.unstubAllGlobals()
  })

  it('generates keys, reconnects, streams as winner and fulfills as owner', async () => {
    const sockets: FakeSocket[] = []
    vi.stubGlobal('WebSocket', function WebSocket() {
      const sock = new FakeSocket()
      sockets.push(sock)
      return sock
    })
    const store = new SnapshotStore()
    const saved: string[] = []
    const conn = new ArenaConnection('wss://x', 'INVITECODE12AB', store, {
      async resolve() { return undefined },
      async set(_ref, value) { saved.push(value) },
    })
    await conn.start()
    expect(saved.length).toBe(1)
    const sock = sockets[0]!
    sock.emit('open')
    sock.emit('message', JSON.stringify({ type: 'auth.session', payload: { deviceId: '11111111-1111-7111-8111-111111111111' } }))

    await expect(async () => {
      const orphan = new ArenaConnection('', '', store)
      for await (const _ of orphan.streamAsWinner({ provider: 'p', model: 'm', messages: [] }, {
        grantId: newGrantId(), ownerDeviceId: 'o', winnerDeviceId: 'w', model: 'm', provider: 'p',
        callsRemaining: 1, activeConcurrency: 0, onlineMsRemaining: 1, ownerOnline: true,
        status: 'active', statusReason: 'active', version: 1,
      })) { /* drain */ }
    }).rejects.toThrow(/not ready/)

    const grantId = newGrantId()
    const owner = generateDeviceKeypair()
    store.patch({
      grants: [{
        grantId, ownerDeviceId: 'o', winnerDeviceId: 'w', model: 'owned', provider: 'openai-compatible',
        callsRemaining: 1, activeConcurrency: 0, onlineMsRemaining: 1, ownerOnline: true,
        status: 'active', statusReason: 'active', version: 1,
      }],
    })
    conn.ownerLlm = {
      async * stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const winnerPub = conn.keys!.x25519PublicKey
    const box = sealWinnerRequest({
      winnerPrivate: conn.keys!.x25519PrivateKey,
      ownerPublic: conn.keys!.x25519PublicKey,
      grantId,
      inferenceId: newInferenceId(),
      options: { provider: 'attacker', model: 'x', messages: ['hi'] },
    }).box
    const ownerApi = conn as unknown as { fulfillAsOwner(payload: Record<string, unknown>): Promise<void> }
    const fulfill = ownerApi.fulfillAsOwner({
      grantId,
      inferenceId: newInferenceId(),
      winnerX25519PublicKey: winnerPub,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    })
    await Promise.resolve()
    sock.emit('message', JSON.stringify({ type: 'relay.inference_started', payload: {} }))
    await fulfill

    const abort = new AbortController()
    abort.abort()
    const grant = {
      grantId, ownerDeviceId: 'o', winnerDeviceId: 'w', model: 'm', provider: 'p',
      callsRemaining: 1, activeConcurrency: 0, onlineMsRemaining: 1, ownerOnline: true,
      status: 'active' as const, statusReason: 'active' as const, version: 1,
      ownerX25519PublicKey: owner.x25519PublicKey,
    }
    const chunks: unknown[] = []
    const stream = conn.streamAsWinner({ provider: 'p', model: 'm', messages: ['hi'], signal: abort.signal }, grant)
    const started = (async () => {
      for await (const chunk of stream) chunks.push(chunk)
    })()
    await Promise.resolve()
    sock.emit('message', JSON.stringify({ type: 'relay.inference_started', payload: {} }))
    await started

    conn.ownerLlm = {
      async * stream() {
        yield { type: 'finish', reason: { kind: 'error' } }
        throw new Error('provider')
      },
    }
    const fail = ownerApi.fulfillAsOwner({
      grantId,
      inferenceId: newInferenceId(),
      winnerX25519PublicKey: winnerPub,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    })
    await Promise.resolve()
    sock.emit('message', JSON.stringify({ type: 'relay.inference_started', payload: {} }))
    await fail

    sock.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    conn.stop()
    for (const item of sockets) item.close()
    vi.unstubAllGlobals()
    expect(conn.keys).toBeTruthy()
    void owner
  })
})
