import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { fromHex, randomBytes, toHex } from './bytes.ts'

export interface DeviceKeypair {
  deviceId: string
  ed25519PrivateKey: string
  ed25519PublicKey: string
  x25519PrivateKey: string
  x25519PublicKey: string
}

export function generateDeviceKeypair(deviceId: string): DeviceKeypair {
  const edPriv = randomBytes(32)
  const xPriv = randomBytes(32)
  return {
    deviceId,
    ed25519PrivateKey: toHex(edPriv),
    ed25519PublicKey: toHex(ed25519.getPublicKey(edPriv)),
    x25519PrivateKey: toHex(xPriv),
    x25519PublicKey: toHex(x25519.getPublicKey(xPriv)),
  }
}

export function signChallenge(privateKeyHex: string, nonce: string): string {
  const message = new TextEncoder().encode(nonce)
  return toHex(ed25519.sign(message, fromHex(privateKeyHex)))
}

export function verifyChallenge(publicKeyHex: string, nonce: string, signatureHex: string): boolean {
  try {
    return ed25519.verify(fromHex(signatureHex), new TextEncoder().encode(nonce), fromHex(publicKeyHex))
  } catch {
    return false
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
