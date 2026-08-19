import { PROVIDER_ID, RPC_CHANNEL } from '@agent-colosseum/protocol'
import { ArenaLlmAdapter } from './host/llm-adapter.ts'
import { handleArenaRpc } from './host/rpc.ts'
import { ArenaRuntime, type PluginConfig } from './host/runtime.ts'

export const name = 'agent-colosseum'
export const inject = ['llm', 'agents']

export interface Config extends PluginConfig {}

const defaults: Config = {
  serverUrl: 'wss://127.0.0.1:8787/v1/ws',
  inviteCode: '',
  allowUnverifiedDsh: false,
}

export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'schemastery',
    validate(value: unknown) {
      const input = (value ?? {}) as Partial<Config>
      return {
        value: {
          serverUrl: input.serverUrl ?? process.env.ARENA_URL ?? defaults.serverUrl,
          inviteCode: input.inviteCode ?? process.env.ARENA_INVITE_CODE ?? '',
          allowUnverifiedDsh: input.allowUnverifiedDsh ?? process.env.ARENA_ALLOW_UNVERIFIED_DSH === '1',
        },
      }
    },
  },
}

type HostCtx = {
  llm: {
    registerAdapter(providers: string[], adapter: unknown): (() => void) & { replace(providers: string[]): void }
    listProviders(): Array<{ id: string; name: string }>
    listModels(provider: string): Promise<Array<{ id: string; name: string }>>
  }
  agents: { create(options: unknown): Promise<{ agent: unknown; dispose(): Promise<void> }> }
  connection?: {
    rpc: {
      handle(
        channel: string,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
        options: { authority: 'trusted-host' | 'loopback' },
      ): () => Promise<void>
    }
  }
  credentials?: {
    resolve(ref: unknown): Promise<{ value: string } | undefined>
    set(ref: unknown, value: string): Promise<void>
  }
  effect(fn: () => (() => void) | void, label?: string): () => void
}

export function apply(ctx: HostCtx, config: Config): void {
  const runtime = new ArenaRuntime(
    ctx.agents as never,
    config,
    async () => {
      const models = []
      for (const provider of ctx.llm.listProviders().filter((item) => item.id !== PROVIDER_ID)) {
        if (provider.id === 'script') continue
        try {
          for (const model of await ctx.llm.listModels(provider.id)) {
            models.push({
              provider: provider.id,
              model: model.id,
              name: `${provider.name}/${model.name}`,
              allowedForStake: provider.id === 'openai-compatible' || provider.id.startsWith('openai'),
            })
          }
        } catch { continue }
      }
      return models
    },
    ctx.credentials
      ? { resolve: async (ref) => ctx.credentials!.resolve(ref), set: async (ref, value) => ctx.credentials!.set(ref, value) }
      : undefined,
  )

  ctx.effect(() => {
    void runtime.start()
    const adapter = new ArenaLlmAdapter(
      () => runtime.store.snapshot.grants as never,
      async function* relay() {
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'RELAY_UNBOUND', message: 'owner relay is not connected' } } }
      },
    )
    const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const offGrants = () => runtime.grantListeners.delete(refresh)
    const refresh = () => registration.replace([PROVIDER_ID])
    runtime.grantListeners.add(refresh)
    const offRpc = ctx.connection?.rpc.handle(
      RPC_CHANNEL,
      async (endpoint, payload) => handleArenaRpc(runtime, endpoint, payload),
      { authority: 'trusted-host' },
    )
    return () => {
      offGrants()
      registration()
      void offRpc?.()
      void runtime.dispose()
    }
  }, 'agent-colosseum: host')
}

export { ArenaRuntime } from './host/runtime.ts'
export { ArenaLlmAdapter } from './host/llm-adapter.ts'
export { ArenaAgentRunner } from './host/agent-runner.ts'
export { handleArenaRpc } from './host/rpc.ts'
