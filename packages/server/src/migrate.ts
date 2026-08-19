import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadConfig } from './config.ts'

const here = dirname(fileURLToPath(import.meta.url))

export async function migrate(databaseUrl = loadConfig().databaseUrl): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8')
  await pool.query(sql)
  await pool.end()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
