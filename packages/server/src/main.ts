import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { Redis } from 'ioredis'
import { ArenaService } from './arena.ts'
import { loadConfig } from './config.ts'
import { sha256Hex } from './hash.ts'
import { buildServer } from './http.ts'
import { logJson } from './log.ts'
import { PostgresStore } from './postgres.ts'

const here = (() => {
  try {
    if (import.meta.url) return dirname(fileURLToPath(import.meta.url))
  } catch { /* bundled CJS has no import.meta.url */ }
  return process.cwd()
})()

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT pg_advisory_lock(87231001)')
  try {
    const sql = readFileSync(join(here, 'schema.sql'), 'utf8')
    await pool.query(sql)
  } finally {
    await pool.query('SELECT pg_advisory_unlock(87231001)')
  }
}

export async function startArena(env: NodeJS.ProcessEnv = process.env): Promise<{
  close(): Promise<void>
}> {
  const config = loadConfig(env)
  if (!config.databaseUrl || !config.redisUrl || !config.publicBaseUrl) {
    throw new Error('DATABASE_URL, REDIS_URL and ARENA_PUBLIC_BASE_URL are required')
  }
  const pool = new pg.Pool({ connectionString: config.databaseUrl })
  pool.on('error', (error) => {
    logJson('error', 'pg.idle', { message: error instanceof Error ? error.message : 'pg' })
  })
  const redis = new Redis(config.redisUrl)
  redis.on('error', (error) => {
    logJson('error', 'redis.idle', { message: error instanceof Error ? error.message : 'redis' })
  })
  await migrate(pool)
  for (const [hash, { uses }] of config.inviteHashes) {
    await pool.query(
      `INSERT INTO invites (code_hash, uses_remaining, max_uses) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`,
      [hash, uses],
    )
  }
  const store = new PostgresStore(pool)
  const arena = new ArenaService(store, config)
  await arena.restoreLive()
  const app = await buildServer(arena, config, {
    redisPing: async () => (await redis.ping()) === 'PONG',
  })
  await app.listen({ host: config.host, port: config.port })
  logJson('info', 'arena.listen', { port: config.port, inviteSeeded: config.inviteHashes.size })
  void sha256Hex
  return {
    async close() {
      await app.close()
      await pool.end()
      redis.disconnect()
    },
  }
}

async function main(): Promise<void> {
  await startArena()
}

const launchedDirectly = Boolean(
  process.argv[1]
  && (
    process.argv[1].endsWith('/main.ts')
    || process.argv[1].endsWith('/main.js')
    || process.argv[1].endsWith('/main.cjs')
    || (import.meta.url !== undefined && import.meta.url === `file://${process.argv[1]}`)
  ),
)

if (launchedDirectly) {
  main().catch((error) => {
    logJson('error', 'arena.fatal', { message: error instanceof Error ? error.message : 'fatal' })
    process.exit(1)
  })
}
