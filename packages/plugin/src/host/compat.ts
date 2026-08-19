import { PINNED_DSH_VERSION } from '@agent-colosseum/protocol'
import { createRequire } from 'node:module'

export class IncompatibleDshError extends Error {
  constructor(found: string) {
    super(`agent-colosseum refuses unverified DeepSeek Harness ${found}; pin ${PINNED_DSH_VERSION}`)
    this.name = 'IncompatibleDshError'
  }
}

export function detectDshVersion(): string {
  if (process.env.DSH_VERSION === PINNED_DSH_VERSION) return PINNED_DSH_VERSION
  try {
    const require = createRequire(import.meta.url)
    for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-agent']) {
      try {
        const pkg = require(`${name}/package.json`) as { version?: string }
        if (pkg.version) return pkg.version
      } catch { continue }
    }
  } catch { /* fall through */ }
  return process.env.DSH_VERSION ?? 'unknown'
}

export function assertCompatible(allowUnverified = false): string {
  const found = detectDshVersion()
  if (found === PINNED_DSH_VERSION) return found
  if (allowUnverified) return found
  throw new IncompatibleDshError(found)
}
