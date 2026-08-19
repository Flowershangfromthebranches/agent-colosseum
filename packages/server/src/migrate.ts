import pg from 'pg'
import { loadConfig } from './config.ts'
import { migrate } from './main.ts'

const config = loadConfig()
const pool = new pg.Pool({ connectionString: config.databaseUrl })
await migrate(pool)
await pool.end()
