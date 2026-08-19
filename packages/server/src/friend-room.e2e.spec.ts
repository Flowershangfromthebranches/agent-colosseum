import { describe, expect, it } from 'vitest'
import { generateDeviceKeypair, signStake, signUtf8, toHex, randomBytes } from '@agent-colosseum/crypto'
import { PROTOCOL_VERSION, defaultStakeSpec, newMessageId } from '@agent-colosseum/protocol'
import { ArenaService } from './arena.ts'
import { buildServer } from './http.ts'
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

async function openClient(url: string) {
  const ws = new WebSocket(url)
  const inbox: Array<Record<string, unknown>> = []
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('ws error')))
  })
  ws.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)) as Record<string, unknown>)
  })
  const wait = async (type: string, timeoutMs = 4_000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const hit = inbox.find((item) => item.type === type)
      if (hit) return hit
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`missing ${type}: ${inbox.map((item) => item.type).join(',')}`)
  }
  return { ws, inbox, wait }
}

describe('friend-room two sockets', () => {
  it('plays a fold through both authenticated sockets', async () => {
    const store = new MemoryStore()
    await store.seedInvite(sha256Hex(INVITE), 8)
    const arena = new ArenaService(store, {
      host: '127.0.0.1', port: 0, databaseUrl: '', redisUrl: '',
      inviteHashes: new Map(), providerAllowlist: ['openai-compatible'], publicBaseUrl: 'http://127.0.0.1',
    })
    const live = process.env.ARENA_WS_URL
    let app: { close(): Promise<void> } | undefined
    let url = live
    if (!url) {
      const built = await buildServer(arena, arena.config, { redisPing: async () => true })
      await built.listen({ host: '127.0.0.1', port: 0 })
      app = built
      const address = built.server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      url = `ws://127.0.0.1:${port}/v1/ws`
    }
    const host = await openClient(url)
    const guest = await openClient(url)
    const hostKeys = generateDeviceKeypair()
    const guestKeys = generateDeviceKeypair()
    const hostInvite = live ? 'E2EHOSTINVITE01' : INVITE
    const guestInvite = live ? 'E2EGUESTINVITE02' : INVITE
    host.ws.send(frame('auth.hello', {
      inviteCode: hostInvite, ed25519PublicKey: hostKeys.ed25519PublicKey, x25519PublicKey: hostKeys.x25519PublicKey,
    }))
    guest.ws.send(frame('auth.hello', {
      inviteCode: guestInvite, ed25519PublicKey: guestKeys.ed25519PublicKey, x25519PublicKey: guestKeys.x25519PublicKey,
    }))
    const hostCh = await host.wait('auth.challenge')
    const guestCh = await guest.wait('auth.challenge')
    host.ws.send(frame('auth.challenge_response', {
      nonce: String((hostCh.payload as { nonce: string }).nonce),
      signature: signUtf8(hostKeys.ed25519PrivateKey, String((hostCh.payload as { nonce: string }).nonce)),
    }))
    guest.ws.send(frame('auth.challenge_response', {
      nonce: String((guestCh.payload as { nonce: string }).nonce),
      signature: signUtf8(guestKeys.ed25519PrivateKey, String((guestCh.payload as { nonce: string }).nonce)),
    }))
    const hostSession = await host.wait('auth.session')
    const guestSession = await guest.wait('auth.session')
    const hostId = String((hostSession.payload as { deviceId: string }).deviceId)
    const guestId = String((guestSession.payload as { deviceId: string }).deviceId)
    const hostStakeUnsigned = defaultStakeSpec(hostId, 'openai-compatible', 'm1', toHex(randomBytes(16)), 'pending')
    const guestStakeUnsigned = defaultStakeSpec(guestId, 'openai-compatible', 'm2', toHex(randomBytes(16)), 'pending')
    const hostStake = { ...hostStakeUnsigned, signature: signStake(hostKeys.ed25519PrivateKey, hostStakeUnsigned) }
    const guestStake = { ...guestStakeUnsigned, signature: signStake(guestKeys.ed25519PrivateKey, guestStakeUnsigned) }
    host.ws.send(frame('room.create', { stake: hostStake }))
    const created = await host.wait('room.created')
    const room = created.payload as { roomId: string; roomCode: string }
    guest.ws.send(frame('room.join', { roomCode: room.roomCode, stake: guestStake }))
    await host.wait('room.updated')
    host.ws.send(frame('room.accept', { roomId: room.roomId, stake: hostStake }))
    await host.wait('room.updated')
    guest.ws.send(frame('room.accept', { roomId: room.roomId, stake: guestStake }))
    const proposal = await Promise.race([
      host.wait('match.proposal'),
      guest.wait('match.proposal'),
      host.wait('error').then((frame) => { throw new Error(`host error ${JSON.stringify(frame.payload)}`) }),
      guest.wait('error').then((frame) => { throw new Error(`guest error ${JSON.stringify(frame.payload)}`) }),
    ])
    expect((proposal.payload as { matchId: string }).matchId).toBeTruthy()
    host.ws.close()
    guest.ws.close()
    if (app) await app.close()
  })
})
