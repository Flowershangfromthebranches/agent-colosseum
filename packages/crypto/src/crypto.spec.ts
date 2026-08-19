import { describe, expect, it } from 'vitest'
import { generateDeviceKeypair, signChallenge, verifyChallenge } from './device-keys.ts'
import { deriveSharedKey, openJson, sealJson } from './e2e.ts'
import { genesisHash, nextEventHash, verifyEventChain } from './hash-chain.ts'
import { commitServerSeed, dealFromDeck, deriveHandDeck, STANDARD_DECK, verifyServerSeed } from './shuffle.ts'
import { toHex, randomBytes } from './bytes.ts'
import { uuidv7 } from '@agent-colosseum/protocol'

describe('device keys', () => {
  it('signs and verifies challenges', () => {
    const keys = generateDeviceKeypair(uuidv7())
    const nonce = toHex(randomBytes(16))
    const sig = signChallenge(keys.ed25519PrivateKey, nonce)
    expect(verifyChallenge(keys.ed25519PublicKey, nonce, sig)).toBe(true)
    expect(verifyChallenge(keys.ed25519PublicKey, 'other', sig)).toBe(false)
  })
})

describe('e2e', () => {
  it('round-trips sealed JSON', () => {
    const a = generateDeviceKeypair(uuidv7())
    const b = generateDeviceKeypair(uuidv7())
    const key = deriveSharedKey(a.x25519PrivateKey, b.x25519PublicKey)
    const other = deriveSharedKey(b.x25519PrivateKey, a.x25519PublicKey)
    expect(toHex(key)).toBe(toHex(other))
    const box = sealJson(key, { hello: 'world' })
    expect(openJson(other, box)).toEqual({ hello: 'world' })
  })
})

describe('shuffle', () => {
  it('commits, derives unique decks, and deals 9 unique cards', () => {
    const commit = commitServerSeed()
    expect(verifyServerSeed(commit.serverSeedHex, commit.commitment)).toBe(true)
    const matchId = uuidv7()
    const e1 = toHex(randomBytes(32))
    const e2 = toHex(randomBytes(32))
    const deck = deriveHandDeck({
      matchId,
      handNo: 1,
      serverSeedHex: commit.serverSeedHex,
      playerEntropy: [e1, e2],
    })
    expect(deck).toHaveLength(52)
    expect(new Set(deck).size).toBe(52)
    expect([...deck].sort().join()).toBe([...STANDARD_DECK].sort().join())
    const dealt = dealFromDeck(deck)
    const used = [...dealt.buttonHole, ...dealt.bbHole, ...dealt.board]
    expect(new Set(used).size).toBe(9)
    const again = deriveHandDeck({
      matchId,
      handNo: 1,
      serverSeedHex: commit.serverSeedHex,
      playerEntropy: [e1, e2],
    })
    expect(again).toEqual(deck)
    const next = deriveHandDeck({
      matchId,
      handNo: 2,
      serverSeedHex: commit.serverSeedHex,
      playerEntropy: [e1, e2],
    })
    expect(next).not.toEqual(deck)
  })
})

describe('hash chain', () => {
  it('verifies an append-only event chain', () => {
    const a = { type: 'start', n: 1 }
    const b = { type: 'action', n: 2 }
    const h1 = nextEventHash(genesisHash(), a)
    const h2 = nextEventHash(h1, b)
    expect(verifyEventChain([
      { hash: h1, payload: a },
      { hash: h2, payload: b },
    ])).toBe(true)
    expect(verifyEventChain([
      { hash: h1, payload: a },
      { hash: 'dead', payload: b },
    ])).toBe(false)
  })
})
