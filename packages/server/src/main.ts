import { ArenaService } from './arena.ts'
import { loadConfig } from './config.ts'
import { buildServer } from './http.ts'
import { migrate } from './migrate.ts'
import { PostgresStore } from './postgres.ts'
import pg from 'pg'

async function main(): Promise<void> {
  const config = loadConfig()
  await migrate(config.databaseUrl)
  const pool = new pg.Pool({ connectionString: config.databaseUrl })
  const arena = new ArenaService(new PostgresStore(pool), config)
  const app = await buildServer(arena, config)
  await app.listen({ host: config.host, port: config.port })
  console.log(`arena listening on ${config.host}:${config.port}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
