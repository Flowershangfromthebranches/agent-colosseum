import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { ENTROPY_DOMAIN, IDENTITY_DOMAIN, STAKE_DOMAIN, stakeCanonicalPayload, type StakeSpecV1 } from '@agent-colosseum/protocol'
import { fromHex, randomBytes, toHex } from './bytes.ts'

export interface DeviceKeypair {
  ed25519PrivateKey: string
  ed25519PublicKey: string
  x25519PrivateKey: string
  x25519PublicKey: string
}

export function generateDeviceKeypair(): DeviceKeypair {
  const edPriv = randomBytes(32)
  const xPriv = randomBytes(32)
  return {
    ed25519PrivateKey: toHex(edPriv),
    ed25519PublicKey: toHex(ed25519.getPublicKey(edPriv)),
    x25519PrivateKey: toHex(xPriv),
    x25519PublicKey: toHex(x25519.getPublicKey(xPriv)),
  }
}

export function signUtf8(privateKeyHex: string, message: string): string {
  return toHex(ed25519.sign(new TextEncoder().encode(message), fromHex(privateKeyHex)))
}

export function verifyUtf8(publicKeyHex: string, message: string, signatureHex: string): boolean {
  try {
    return ed25519.verify(fromHex(signatureHex), new TextEncoder().encode(message), fromHex(publicKeyHex))
  } catch {
    return false
  }
}

export function identityPayload(deviceId: string, nonce: string): string {
  return `${IDENTITY_DOMAIN}\n${deviceId}\n${nonce}`
}

export function signIdentity(privateKeyHex: string, deviceId: string, nonce: string): string {
  return signUtf8(privateKeyHex, identityPayload(deviceId, nonce))
}

export function verifyIdentity(publicKeyHex: string, deviceId: string, nonce: string, signature: string): boolean {
  return verifyUtf8(publicKeyHex, identityPayload(deviceId, nonce), signature)
}

export function signStake(privateKeyHex: string, spec: Omit<StakeSpecV1, 'signature'>): string {
  return signUtf8(privateKeyHex, `${STAKE_DOMAIN}\n${stakeCanonicalPayload(spec)}`)
}

export function verifyStake(publicKeyHex: string, spec: StakeSpecV1): boolean {
  const { signature, ...rest } = spec
  return verifyUtf8(publicKeyHex, `${STAKE_DOMAIN}\n${stakeCanonicalPayload(rest)}`, signature)
}

export function signEntropy(privateKeyHex: string, matchId: string, entropyHex: string): string {
  return signUtf8(privateKeyHex, `${ENTROPY_DOMAIN}\n${matchId}\n${entropyHex}`)
}

export function verifyEntropy(publicKeyHex: string, matchId: string, entropyHex: string, signature: string): boolean {
  return verifyUtf8(publicKeyHex, `${ENTROPY_DOMAIN}\n${matchId}\n${entropyHex}`, signature)
}

export function signChallenge(privateKeyHex: string, nonce: string): string {
  return signUtf8(privateKeyHex, nonce)
}

export function verifyChallenge(publicKeyHex: string, nonce: string, signatureHex: string): boolean {
  return verifyUtf8(publicKeyHex, nonce, signatureHex)
}
