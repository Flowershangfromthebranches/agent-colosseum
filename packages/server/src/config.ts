export interface ServerConfig {
  host: string
  port: number
  databaseUrl: string
  redisUrl: string
  inviteCodes: string[]
  providerAllowlist: string[]
  publicBaseUrl: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const inviteCodes = (env.ARENA_INVITE_CODES ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const providerAllowlist = (env.ARENA_PROVIDER_ALLOWLIST ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    host: env.ARENA_HOST ?? '0.0.0.0',
    port: Number(env.ARENA_PORT ?? 8787),
    databaseUrl: env.DATABASE_URL ?? 'postgres://arena:arena@127.0.0.1:5432/arena',
    redisUrl: env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    inviteCodes,
    providerAllowlist,
    publicBaseUrl: env.ARENA_PUBLIC_BASE_URL ?? 'http://127.0.0.1:8787',
  }
}

export function isProviderAllowed(allowlist: readonly string[], provider: string): boolean {
  if (allowlist.length === 0) return false
  return allowlist.includes(provider)
}
