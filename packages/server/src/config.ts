export interface ServerConfig {
  host: string
  port: number
  databaseUrl: string
  redisUrl: string
  inviteHashes: Map<string, { uses: number }>
  providerAllowlist: string[]
  publicBaseUrl: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const inviteHashes = new Map<string, { uses: number }>()
  for (const item of (env.ARENA_INVITE_HASHES ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [hash, uses] = item.split(':')
    if (hash) inviteHashes.set(hash, { uses: Number(uses ?? 1) })
  }
  return {
    host: env.ARENA_HOST ?? '0.0.0.0',
    port: Number(env.ARENA_PORT ?? 8787),
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    inviteHashes,
    providerAllowlist: (env.ARENA_PROVIDER_ALLOWLIST ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    publicBaseUrl: env.ARENA_PUBLIC_BASE_URL ?? '',
  }
}

export function isProviderAllowed(allowlist: readonly string[], provider: string): boolean {
  return allowlist.includes(provider)
}
