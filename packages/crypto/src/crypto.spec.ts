import { describe, expect, it } from 'vitest'
import { uuidv7 } from '@agent-colosseum/protocol'
import { generateDeviceKeypair, signIdentity, verifyIdentity } from './device-keys.ts'
import { deriveSharedKey, openJson, relayAad, sealJson } from './e2e.ts'
import { genesisHash, nextEventHash, verifyEventChain } from './hash-chain.ts'
import { commitServerSeed, dealFromDeck, deriveHandDeck, STANDARD_DECK, verifyServerSeed } from './shuffle.ts'
import { toHex, randomBytes } from './bytes.ts'

describe('stake and entropy signatures', () => {
  it('signs and verifies stake and entropy payloads', async () => {
    const { defaultStakeSpec } = await import('@agent-colosseum/protocol')
    const { signStake, verifyStake, signEntropy, verifyEntropy } = await import('./device-keys.ts')
    const keys = generateDeviceKeypair()
    const spec = defaultStakeSpec(uuidv7(), 'openai-compatible', 'm', toHex(randomBytes(16)), 'pending')
    const signed = { ...spec, signature: signStake(keys.ed25519PrivateKey, spec) }
    expect(verifyStake(keys.ed25519PublicKey, signed)).toBe(true)
    expect(verifyStake(keys.ed25519PublicKey, { ...signed, signature: '00' })).toBe(false)
    const matchId = uuidv7()
    const entropy = toHex(randomBytes(32))
    const sig = signEntropy(keys.ed25519PrivateKey, matchId, entropy)
    expect(verifyEntropy(keys.ed25519PublicKey, matchId, entropy, sig)).toBe(true)
    expect(verifyEntropy(keys.ed25519PublicKey, matchId, 'ff', sig)).toBe(false)
  })
})

describe('identity', () => {
  it('binds signatures to domain, device and nonce', () => {
    const keys = generateDeviceKeypair()
    const deviceId = uuidv7()
    const nonce = toHex(randomBytes(16))
    const sig = signIdentity(keys.ed25519PrivateKey, deviceId, nonce)
    expect(verifyIdentity(keys.ed25519PublicKey, deviceId, nonce, sig)).toBe(true)
    expect(verifyIdentity(keys.ed25519PublicKey, deviceId, 'other', sig)).toBe(false)
  })
})

describe('e2e aad', () => {
  it('rejects swapped direction or tampered ciphertext', () => {
    const a = generateDeviceKeypair()
    const b = generateDeviceKeypair()
    const key = deriveSharedKey(a.x25519PrivateKey, b.x25519PublicKey)
    const aad = relayAad({ grantId: uuidv7(), inferenceId: uuidv7(), seq: 0, direction: 'winner_to_owner' })
    const box = sealJson(key, { hello: 'world' }, aad)
    expect(openJson(key, box, aad)).toEqual({ hello: 'world' })
    const wrong = relayAad({ grantId: uuidv7(), inferenceId: uuidv7(), seq: 0, direction: 'owner_to_winner' })
    expect(() => openJson(key, box, wrong)).toThrow()
    expect(() => openJson(key, { ...box, ciphertext: box.ciphertext.replace(/0/g, '1') }, aad)).toThrow()
  })
})

describe('shuffle', () => {
  it('commits and derives unique decks', () => {
    const commit = commitServerSeed()
    expect(verifyServerSeed(commit.serverSeedHex, commit.commitment)).toBe(true)
    const matchId = uuidv7()
    const e1 = toHex(randomBytes(32))
    const e2 = toHex(randomBytes(32))
    const cards = deriveHandDeck({ matchId, handNo: 1, serverSeedHex: commit.serverSeedHex, playerEntropy: [e1, e2] })
    expect(new Set(cards).size).toBe(52)
    expect([...cards].sort().join()).toBe([...STANDARD_DECK].sort().join())
    expect(dealFromDeck(cards).buttonHole).toHaveLength(2)
  })
})

describe('hash chain', () => {
  it('verifies append-only events', () => {
    const a = { type: 'start' }
    const h1 = nextEventHash(genesisHash(), a)
    expect(verifyEventChain([{ hash: h1, payload: a }])).toBe(true)
    expect(verifyEventChain([{ hash: 'dead', payload: a }])).toBe(false)
  })
})
