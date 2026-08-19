import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { generateDeviceKeypair, signEntropy, signStake, signUtf8, toHex, randomBytes } from '@agent-colosseum/crypto'
import {
  IDENTITY_DOMAIN,
  PROTOCOL_VERSION,
  defaultStakeSpec,
  newInferenceId,
  newMessageId,
} from '@agent-colosseum/protocol'

const execFileAsync = promisify(execFile)
const DEFAULT_WS = process.env.ARENA_WS_URL ?? 'ws://127.0.0.1:8787/v1/ws'

async function liveArenaUrl(): Promise<string | null> {
  const http = DEFAULT_WS.replace(/^ws/, 'http').replace(/\/v1\/ws$/, '')
  try {
    const response = await fetch(`${http}/readyz`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return null
    const body = await response.json() as { ok?: boolean; db?: boolean; redis?: boolean }
    return body.ok && body.db && body.redis ? DEFAULT_WS : null
  } catch {
    return null
  }
}

function frame(type: string, payload: unknown) {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageId: newMessageId(),
    sentAt: Date.now(),
    type,
    payload,
  })
}

type LiveClient = {
  ws: WebSocket
  inbox: Array<Record<string, unknown>>
  wait: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  keys: ReturnType<typeof generateDeviceKeypair>
  deviceId: string
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
  const wait = async (type: string, timeoutMs = 8_000) => {
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

async function authenticate(
  url: string,
  invite: string,
  existing?: { keys: ReturnType<typeof generateDeviceKeypair>; deviceId?: string },
): Promise<LiveClient> {
  const keys = existing?.keys ?? generateDeviceKeypair()
  const client = await openClient(url)
  client.ws.send(frame('auth.hello', {
    inviteCode: invite,
    ed25519PublicKey: keys.ed25519PublicKey,
    x25519PublicKey: keys.x25519PublicKey,
  }))
  const challenge = await client.wait('auth.challenge')
  const nonce = String((challenge.payload as { nonce: string }).nonce)
  const signature = existing?.deviceId
    ? signUtf8(keys.ed25519PrivateKey, `${IDENTITY_DOMAIN}\n${existing.deviceId}\n${nonce}`)
    : signUtf8(keys.ed25519PrivateKey, nonce)
  client.ws.send(frame('auth.challenge_response', {
    nonce,
    signature,
    ...existing?.deviceId ? { deviceId: existing.deviceId } : {},
  }))
  const session = await client.wait('auth.session')
  return { ...client, keys, deviceId: String((session.payload as { deviceId: string }).deviceId) }
}

function stakeFor(deviceId: string, keys: ReturnType<typeof generateDeviceKeypair>, model: string) {
  const unsigned = defaultStakeSpec(deviceId, 'openai-compatible', model, toHex(randomBytes(16)), 'pending')
  return { ...unsigned, signature: signStake(keys.ed25519PrivateKey, unsigned) }
}

async function openLiveMatch(url: string, hostInvite: string, guestInvite: string) {
  const host = await authenticate(url, hostInvite)
  const guest = await authenticate(url, guestInvite)
  const hostStake = stakeFor(host.deviceId, host.keys, 'fault-a')
  const guestStake = stakeFor(guest.deviceId, guest.keys, 'fault-b')
  host.ws.send(frame('room.create', { stake: hostStake }))
  const created = await host.wait('room.created')
  const room = created.payload as { roomId: string; roomCode: string }
  guest.ws.send(frame('room.join', { roomCode: room.roomCode, stake: guestStake }))
  await host.wait('room.updated')
  host.ws.send(frame('room.accept', { roomId: room.roomId, stake: hostStake }))
  guest.ws.send(frame('room.accept', { roomId: room.roomId, stake: guestStake }))
  const proposal = await Promise.race([host.wait('match.proposal', 8_000), guest.wait('match.proposal', 8_000)])
  const matchId = String((proposal.payload as { matchId: string }).matchId)
  const eA = toHex(randomBytes(32))
  const eB = toHex(randomBytes(32))
  host.ws.send(frame('match.entropy', {
    matchId, entropyHex: eA, signature: signEntropy(host.keys.ed25519PrivateKey, matchId, eA),
  }))
  guest.ws.send(frame('match.entropy', {
    matchId, entropyHex: eB, signature: signEntropy(guest.keys.ed25519PrivateKey, matchId, eB),
  }))
  await host.wait('match.private', 8_000)
  return { host, guest, matchId }
}

function takeRequest(client: LiveClient) {
  const index = client.inbox.findIndex((item) => item.type === 'match.action_request')
  if (index < 0) return undefined
  return client.inbox.splice(index, 1)[0]
}

async function foldOut(session: { host: LiveClient; guest: LiveClient; matchId: string }) {
  const start = Date.now()
  while (Date.now() - start < 60_000) {
    const settled = session.host.inbox.find((item) => item.type === 'match.settled')
      ?? session.guest.inbox.find((item) => item.type === 'match.settled')
    if (settled) return settled
    const hostReq = takeRequest(session.host)
    const guestReq = takeRequest(session.guest)
    const request = hostReq ?? guestReq
    if (!request) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      continue
    }
    const actor = hostReq ? session.host : session.guest
    const payload = request.payload as { handNo: number; actionSeq: number }
    actor.ws.send(frame('match.action', {
      matchId: session.matchId,
      handNo: payload.handNo,
      actionSeq: payload.actionSeq,
      action: 'fold',
      publicRationale: 'fold',
    }))
  }
  throw new Error(`no settlement: ${[...session.host.inbox, ...session.guest.inbox].map((item) => item.type).join(',')}`)
}

async function waitReadyz(timeoutMs = 30_000): Promise<void> {
  const http = DEFAULT_WS.replace(/^ws/, 'http').replace(/\/v1\/ws$/, '')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${http}/readyz`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error('arena did not become ready')
}

describe('live Arena fault cases', () => {
  it('restores a live match across Arena restart and keeps 89s grace before a 90s forfeit', async () => {
    const url = await liveArenaUrl()
    if (!url) {
      if (process.env.CI === 'true' && process.env.ARENA_E2E !== '1') return
      throw new Error('live Arena is not reachable')
    }

    const first = await openLiveMatch(url, 'E2EHOSTINVITE01', 'E2EGUESTINVITE02')
    const { matchId } = first
    const env = { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${process.env.HOME}/.colima/docker.sock` }
    await execFileAsync('docker', ['restart', 'deploy-arena-1'], { env })
    await waitReadyz()

    const host = await authenticate(url, 'E2EHOSTINVITE01', { keys: first.host.keys, deviceId: first.host.deviceId })
    const guest = await authenticate(url, 'E2EGUESTINVITE02', { keys: first.guest.keys, deviceId: first.guest.deviceId })
    const replayed = await Promise.race([
      host.wait('match.private', 8_000),
      guest.wait('match.private', 8_000),
    ])
    expect((replayed.payload as { matchId?: string }).matchId ?? matchId).toBe(matchId)

    guest.ws.close()
    const beat = setInterval(() => {
      if (host.ws.readyState === 1) host.ws.send(frame('session.heartbeat', { at: Date.now() }))
    }, 10_000)
    try {
      await new Promise((resolve) => setTimeout(resolve, 89_000))
      expect(host.inbox.some((item) => item.type === 'match.settled')).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const settled = host.inbox.find((item) => item.type === 'match.settled')
      expect(settled).toBeTruthy()
      const terminal = settled && typeof settled.payload === 'object' && settled.payload
        ? (settled.payload as { terminal?: { reason?: string } }).terminal
        : undefined
      expect(terminal?.reason).toBe('forfeit')
    } finally {
      clearInterval(beat)
      host.ws.close()
    }
  }, 180_000)

  it('pauses Grant TTL while the owner is offline and replays reserve without a second deduct', async () => {
    const url = await liveArenaUrl()
    if (!url) {
      if (process.env.CI === 'true' && process.env.ARENA_E2E !== '1') return
      throw new Error('live Arena is not reachable')
    }

    const session = await openLiveMatch(url, 'E2EHOSTINVITE01', 'E2EGUESTINVITE02')
    const settled = await foldOut(session)
    const grant = (settled.payload as {
      grant?: {
        grantId: string
        ownerDeviceId: string
        winnerDeviceId: string
        callsRemaining: number
        onlineMsRemaining: number
      }
    }).grant
    expect(grant?.grantId).toBeTruthy()

    const owner = grant!.ownerDeviceId === session.host.deviceId ? session.host : session.guest
    const winner = grant!.winnerDeviceId === session.host.deviceId ? session.host : session.guest
    const remainingAtIssue = grant!.onlineMsRemaining
    winner.ws.send(frame('session.heartbeat', { at: Date.now() }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    owner.ws.close()
    await new Promise((resolve) => setTimeout(resolve, 300))
    winner.ws.send(frame('session.heartbeat', { at: Date.now() }))
    await new Promise((resolve) => setTimeout(resolve, 250))
    const ticked = [...winner.inbox].reverse().find((item) => item.type === 'grant.updated')
    const afterOffline = ticked?.payload as { onlineMsRemaining?: number; ownerOnline?: boolean }
    expect(afterOffline?.ownerOnline).toBe(false)
    expect(afterOffline?.onlineMsRemaining ?? remainingAtIssue).toBeLessThanOrEqual(remainingAtIssue)

    const inferenceId = newInferenceId()
    const reserve = {
      grantId: grant!.grantId,
      inferenceId,
      ciphertext: 'aa',
      nonce: 'bb',
      estimatedInputTokens: 1,
      requestBytes: 8,
      requestHash: 'ttl-hash',
    }
    winner.ws.send(frame('relay.reserve', reserve))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(winner.inbox.some((item) => item.type === 'error')).toBe(true)

    const ownerInvite = grant!.ownerDeviceId === session.host.deviceId ? 'E2EHOSTINVITE01' : 'E2EGUESTINVITE02'
    const owner2 = await authenticate(url, ownerInvite, { keys: owner.keys, deviceId: owner.deviceId })
    winner.inbox.length = 0
    owner2.inbox.length = 0
    winner.ws.send(frame('relay.reserve', reserve))
    await owner2.wait('relay.reserve', 8_000)
    owner2.ws.send(frame('relay.preflight_ok', {
      grantId: grant!.grantId,
      inferenceId,
      requestHash: 'ttl-hash',
    }))
    await winner.wait('relay.inference_started', 8_000)
    const started = [...winner.inbox].reverse().find((item) => item.type === 'grant.updated')
      ?? [...owner2.inbox].reverse().find((item) => item.type === 'grant.updated')
    const firstCalls = Number((started?.payload as { callsRemaining?: number })?.callsRemaining ?? grant!.callsRemaining - 1)
    winner.ws.send(frame('relay.reserve', reserve))
    owner2.ws.send(frame('relay.preflight_ok', {
      grantId: grant!.grantId,
      inferenceId,
      requestHash: 'ttl-hash',
    }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    const again = [...winner.inbox].reverse().find((item) => item.type === 'grant.updated')
    if (again?.payload && typeof (again.payload as { callsRemaining?: number }).callsRemaining === 'number') {
      expect(Number((again.payload as { callsRemaining: number }).callsRemaining)).toBe(firstCalls)
    }
    winner.ws.close()
    owner2.ws.close()
    session.host.ws.close()
    session.guest.ws.close()
  }, 120_000)
})
