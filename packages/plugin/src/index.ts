import { PROVIDER_ID, RPC_CHANNEL } from '@agent-colosseum/protocol'
import { ArenaLlmAdapter } from './host/llm-adapter.ts'
import { handleArenaRpc } from './host/rpc.ts'
import { ArenaRuntime, type PluginConfig } from './host/runtime.ts'
import { assertCompatible } from './host/compat.ts'

export const name = 'agent-colosseum'
export const inject = ['llm', 'agents']

export interface Config extends PluginConfig {}

export const Config = {
  serverUrl: { type: 'string', default: 'wss://127.0.0.1:8787/v1/ws' },
  inviteCode: { type: 'string', default: '' },
  allowUnverifiedDsh: { type: 'boolean', default: false },
}

type LooseCtx = {
  llm: {
    registerAdapter(providers: string[], adapter: unknown): (() => void) & { replace(providers: string[]): void }
    listProviders(): Array<{ id: string; name: string }>
    listModels(provider: string): Promise<Array<{ id: string; name: string }>>
    stream(options: unknown): AsyncIterable<unknown>
  }
  agents: {
    create(options: unknown): Promise<{ agent: unknown; dispose(): Promise<void> }>
  }
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

export function apply(ctx: LooseCtx, config: Config): void {
  const version = assertCompatible(config.allowUnverifiedDsh)
  const runtime = new ArenaRuntime(
    ctx.agents as never,
    { ...config },
    async () => {
      const providers = ctx.llm.listProviders().filter((item) => item.id !== PROVIDER_ID)
      const models = []
      for (const provider of providers) {
        try {
          const listed = await ctx.llm.listModels(provider.id)
          for (const model of listed) {
            models.push({
              provider: provider.id,
              model: model.id,
              name: `${provider.name}/${model.name}`,
              allowedForStake: provider.id === 'script' || provider.id.startsWith('openai-compatible'),
            })
          }
        } catch {
          continue
        }
      }
      return models
    },
    ctx.credentials
      ? {
        resolve: async (ref) => ctx.credentials!.resolve(ref),
        set: async (ref, value) => ctx.credentials!.set(ref, value),
      }
      : undefined,
  )

  ctx.effect(() => {
    void runtime.start()
    const adapter = new ArenaLlmAdapter(
      () => runtime.grants,
      async function* relay() {
        yield {
          type: 'finish' as const,
          reason: { kind: 'error' as const, failure: { code: 'RELAY_UNBOUND', message: 'owner relay is not connected' } },
        }
      },
    )
    const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
    const offGrants = runtime.onGrantsChanged(() => {
      registration.replace([PROVIDER_ID])
    })
    const offRpc = ctx.connection?.rpc.handle(
      RPC_CHANNEL,
      async (endpoint, payload) => handleArenaRpc(runtime, endpoint, payload),
      { authority: 'trusted-host' },
    )
    return () => {
      offGrants()
      registration()
      void offRpc?.()
      void runtime.runner.dispose()
    }
  }, 'agent-colosseum: host')
  void version
}

export { ArenaRuntime } from './host/runtime.ts'
export { ArenaLlmAdapter } from './host/llm-adapter.ts'
export { ArenaAgentRunner } from './host/agent-runner.ts'
export { handleArenaRpc } from './host/rpc.ts'
