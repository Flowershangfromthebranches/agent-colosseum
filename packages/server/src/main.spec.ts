import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  default: {
    Pool: class {
      on() { return this }
      async query() { return { rows: [{ ok: 1 }] } }
      async end() {}
      async connect() {
        return { query: async () => ({ rows: [] }), release() {} }
      }
    },
  },
}))

vi.mock('ioredis', async () => {
  const { MemoryRedis } = await import('./redis-runtime.ts')
  return { Redis: MemoryRedis }
})

import { migrate, startArena } from './main.ts'
import { runMigrate } from './migrate.ts'

describe('server startup', () => {
  it('requires database, redis and public url', async () => {
    await expect(startArena({})).rejects.toThrow(/DATABASE_URL/)
  })

  it('migrates and listens when env is complete', async () => {
    const started = await startArena({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      ARENA_PUBLIC_BASE_URL: 'http://127.0.0.1',
      ARENA_HOST: '127.0.0.1',
      ARENA_PORT: '0',
      ARENA_INVITE_HASHES: 'deadbeef:1',
    })
    await started.close()
    const pool = { async query() { return { rows: [] } } }
    await migrate(pool as never)
    await runMigrate({ DATABASE_URL: 'postgres://x' })
  })
})
