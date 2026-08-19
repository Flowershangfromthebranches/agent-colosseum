import { describe, expect, it } from 'vitest'
import { DISCONNECT_FORFEIT_MS, HEARTBEAT_TIMEOUT_MS } from '@agent-colosseum/protocol'
import { MemoryPresence } from './presence.ts'

describe('presence book', () => {
  it('tracks sockets, stale heartbeats and missing devices', () => {
    const book = new MemoryPresence()
    book.beat('ghost', 1)
    expect(book.isOnline('missing', 1)).toBe(false)
    expect(book.offlineSince('missing', 1)).toBeNull()
    book.disconnect('missing', 1)
    expect(book.offlineSince('missing', 1)).toBe(0)
    expect(book.offlineSince('missing', 1 + 1_000)).toBe(1_000)
    book.connect('d', 0)
    book.connect('d', 0)
    expect(book.socketsOf('d')).toBe(2)
    book.beat('d', 10)
    expect(book.isOnline('d', 10)).toBe(true)
    expect(book.offlineSince('d', 10)).toBeNull()
    expect(book.isOnline('d', 10 + HEARTBEAT_TIMEOUT_MS + 1)).toBe(false)
    expect(book.offlineSince('d', 10 + HEARTBEAT_TIMEOUT_MS + 1)).toBeGreaterThan(HEARTBEAT_TIMEOUT_MS)
    book.disconnect('d')
    book.disconnect('d')
    expect(book.socketsOf('d')).toBe(0)
    expect(book.offlineSince('d')).not.toBeNull()
    expect(book.offlineSince('missing', 1 + DISCONNECT_FORFEIT_MS)).toBe(DISCONNECT_FORFEIT_MS)
    book.connect('d')
    expect(book.offlineSince('d')).toBeNull()
  })
})
