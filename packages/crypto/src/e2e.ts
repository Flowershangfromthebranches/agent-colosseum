import { x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromHex, randomBytes, toHex, utf8 } from './bytes.ts'

const INFO = utf8('agent-colosseum/e2e/v1')

export type RelayDirection = 'winner_to_owner' | 'owner_to_winner'

export function deriveSharedKey(ourPrivateHex: string, theirPublicHex: string): Uint8Array {
  const shared = x25519.getSharedSecret(fromHex(ourPrivateHex), fromHex(theirPublicHex))
  return hkdf(sha256, shared, utf8('agent-colosseum'), INFO, 32)
}

export interface SealedBox {
  nonce: string
  ciphertext: string
}

export function relayAad(input: {
  grantId: string
  inferenceId: string
  seq: number
  direction: RelayDirection
}): Uint8Array {
  return utf8(`${input.grantId}|${input.inferenceId}|${input.seq}|${input.direction}`)
}

export function sealJson(key: Uint8Array, value: unknown, aad?: Uint8Array): SealedBox {
  const nonce = randomBytes(12)
  const plaintext = utf8(JSON.stringify(value))
  const ciphertext = gcm(key, nonce, aad).encrypt(plaintext)
  return { nonce: toHex(nonce), ciphertext: toHex(ciphertext) }
}

export function openJson<T>(key: Uint8Array, box: SealedBox, aad?: Uint8Array): T {
  const plaintext = gcm(key, fromHex(box.nonce), aad).decrypt(fromHex(box.ciphertext))
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}
