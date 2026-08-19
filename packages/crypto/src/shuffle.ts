import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, fromHex, randomBytes, toHex, utf8 } from './bytes.ts'
import { sha256Hex } from './hash-chain.ts'

export const STANDARD_DECK: readonly string[] = (() => {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
  const suits = ['s', 'h', 'd', 'c']
  const cards: string[] = []
  for (const suit of suits) {
    for (const rank of ranks) cards.push(`${rank}${suit}`)
  }
  return cards
})()

export interface ShuffleCommitment {
  serverSeedHex: string
  commitment: string
}

export function commitServerSeed(serverSeed = randomBytes(32)): ShuffleCommitment {
  return {
    serverSeedHex: toHex(serverSeed),
    commitment: sha256Hex(serverSeed),
  }
}

export function verifyServerSeed(serverSeedHex: string, commitment: string): boolean {
  return sha256Hex(fromHex(serverSeedHex)) === commitment
}

export function deriveHandDeck(input: {
  matchId: string
  handNo: number
  serverSeedHex: string
  playerEntropy: readonly [string, string]
}): string[] {
  const ikm = concatBytes(
    fromHex(input.serverSeedHex),
    fromHex(input.playerEntropy[0]),
    fromHex(input.playerEntropy[1]),
  )
  const info = utf8(`agent-colosseum/hand/${input.matchId}/${input.handNo}`)
  const material = nobleHkdf(sha256, ikm, utf8(input.matchId), info, 32 * 52)
  const deck = [...STANDARD_DECK]
  // Fisher-Yates with 32-byte big-endian chunks as unbiased-enough indices.
  for (let i = deck.length - 1; i > 0; i--) {
    const offset = (deck.length - 1 - i) * 32
    const slice = material.subarray(offset, offset + 8)
    const n = Number(new DataView(slice.buffer, slice.byteOffset, 8).getBigUint64(0) % BigInt(i + 1))
    const tmp = deck[i]!
    deck[i] = deck[n]!
    deck[n] = tmp
  }
  return deck
}

export interface DealtHand {
  buttonHole: [string, string]
  bbHole: [string, string]
  board: [string, string, string, string, string]
  remaining: string[]
}

export function dealFromDeck(deck: readonly string[]): DealtHand {
  if (new Set(deck).size !== 52 || deck.length !== 52) {
    throw new Error('deck must be a unique 52-card permutation')
  }
  return {
    buttonHole: [deck[0]!, deck[1]!],
    bbHole: [deck[2]!, deck[3]!],
    board: [deck[4]!, deck[5]!, deck[6]!, deck[7]!, deck[8]!],
    remaining: deck.slice(9) as string[],
  }
}
