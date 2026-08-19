import { randomBytes, toHex, verifyIdentity, verifyUtf8 } from '@agent-colosseum/crypto'
import { newDeviceId } from '@agent-colosseum/protocol'
import { sha256Hex } from './hash.ts'
import type { ArenaStore, DeviceRecord } from './store.ts'

export type AuthChallenge = {
  nonce: string
  expiresAt: number
  ed25519: string
  x25519: string
  inviteCode?: string
}

export function issueChallenge(
  challenges: Map<string, AuthChallenge>,
  ed25519: string,
  x25519: string,
  inviteCode?: string,
): { nonce: string; expiresAt: number } {
  const nonce = toHex(randomBytes(24))
  const expiresAt = Date.now() + 30_000
  challenges.set(nonce, { nonce, expiresAt, ed25519, x25519, ...inviteCode ? { inviteCode } : {} })
  return { nonce, expiresAt }
}

export async function redeemDevice(
  store: ArenaStore,
  challenges: Map<string, AuthChallenge>,
  input: { nonce: string; signature: string; inviteCode?: string; deviceId?: string },
): Promise<DeviceRecord> {
  const challenge = challenges.get(input.nonce)
  challenges.delete(input.nonce)
  if (!challenge || challenge.expiresAt < Date.now()) throw new Error('challenge expired')
  const existing = await store.findDeviceByEd25519(challenge.ed25519)
  if (existing) {
    if (existing.x25519PublicKey !== challenge.x25519) throw new Error('IDENTITY_CONFLICT')
    if (input.deviceId && input.deviceId !== existing.deviceId) throw new Error('IDENTITY_CONFLICT')
    if (!verifyIdentity(challenge.ed25519, existing.deviceId, input.nonce, input.signature)) {
      throw new Error('UNAUTHORIZED')
    }
    await store.touchDevice(existing.deviceId, Date.now())
    return existing
  }
  const inviteCode = input.inviteCode ?? challenge.inviteCode
  if (!inviteCode) throw new Error('INVITE_INVALID')
  if (await store.findDeviceByX25519(challenge.x25519)) throw new Error('IDENTITY_CONFLICT')
  const consumed = await store.consumeInvite(sha256Hex(inviteCode))
  if (!consumed) throw new Error('INVITE_EXHAUSTED')
  const firstTimeOk = verifyUtf8(challenge.ed25519, input.nonce, input.signature)
    || verifyIdentity(challenge.ed25519, 'pending', input.nonce, input.signature)
  if (!firstTimeOk) throw new Error('UNAUTHORIZED')
  const device: DeviceRecord = {
    deviceId: newDeviceId(),
    ed25519PublicKey: challenge.ed25519,
    x25519PublicKey: challenge.x25519,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  await store.putDevice(device)
  return device
}
