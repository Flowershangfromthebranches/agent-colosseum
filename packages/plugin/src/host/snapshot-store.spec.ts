import { describe, expect, it } from 'vitest'
import { SnapshotStore } from './snapshot-store.ts'

describe('SnapshotStore', () => {
  it('notifies subscribers and waiters', async () => {
    const store = new SnapshotStore()
    const seen: number[] = []
    const off = store.subscribe((_snap, cursor) => { seen.push(cursor) })
    const waited = store.wait(50)
    store.patch({ view: 'lobby', roomId: undefined })
    await waited
    expect(store.snapshot.view).toBe('lobby')
    expect(seen.length).toBeGreaterThan(0)
    off()
    await store.wait(1)
    expect(store.version).toBeGreaterThan(0)
    await expect(store.waitUntil((snap) => snap.view === 'lobby', 10, 'already')).resolves.toMatchObject({ view: 'lobby' })
    const pending = store.waitUntil((snap) => snap.view === 'table', 50, 'table')
    store.patch({ view: 'table' })
    await expect(pending).resolves.toMatchObject({ view: 'table' })
    await expect(store.waitUntil((snap) => snap.view === 'grants', 10, 'grants')).rejects.toThrow(/grants timeout/)
  })
})
