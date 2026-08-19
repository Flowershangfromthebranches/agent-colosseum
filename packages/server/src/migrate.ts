import pg from 'pg'
import { loadConfig } from './config.ts'
import { migrate } from './main.ts'

export async function runMigrate(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env)
  const pool = new pg.Pool({ connectionString: config.databaseUrl })
  try {
    await migrate(pool)
  } finally {
    await pool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrate()
}
