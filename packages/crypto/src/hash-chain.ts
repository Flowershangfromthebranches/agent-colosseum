import { sha256 } from '@noble/hashes/sha2.js'
import { toHex, utf8 } from './bytes.ts'

export function sha256Hex(value: string | Uint8Array): string {
  return toHex(sha256(typeof value === 'string' ? utf8(value) : value))
}

export function nextEventHash(prevHash: string, payload: unknown): string {
  return sha256Hex(`${prevHash}\n${stableStringify(payload)}`)
}

export function genesisHash(): string {
  return sha256Hex('agent-colosseum/event-chain/v1')
}

export function verifyEventChain(
  events: readonly { hash: string; payload: unknown }[],
  startHash = genesisHash(),
): boolean {
  let prev = startHash
  for (const event of events) {
    const expected = nextEventHash(prev, event.payload)
    if (expected !== event.hash) return false
    prev = event.hash
  }
  return true
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}
