import { apply, handleArenaRpc, runtimeOf, ArenaLlmAdapter } from '../src/index.ts'
import type { ArenaRuntime } from '../src/host/runtime.ts'
import type { GenerateOptions, StreamChunk } from '../src/host/llm-adapter.ts'
import { PROVIDER_ID, type GrantV1 } from '@agent-colosseum/protocol'

process.env.DSH_VERSION ??= '0.1.0-rc.7'

export interface DshHost {
  runtime: ArenaRuntime
  rpc(endpoint: string, payload?: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>
  wait(pred: (runtime: ArenaRuntime) => boolean, timeoutMs: number, label: string): Promise<void>
  streamReward(grant: GrantV1 & { ownerX25519PublicKey?: string }, messages?: unknown[]): Promise<StreamChunk[]>
  dispose(): Promise<void>
}

export function createFoldAgent() {
  const session = {
    events: [] as Array<{ type: string; seq: number; data: { message: { content: Array<{ type: string; text: string }> } } }>,
  }
  let seq = 0
  return {
    ctx: {
      tools: { presentAs: () => () => undefined, restrict: () => () => undefined },
      systemPrompt: { section: () => () => undefined, suppressRuntimeContext: () => () => undefined },
    },
    followup() {
      seq += 1
      session.events.push({
        type: 'assistant/message',
        seq,
        data: { message: { content: [{ type: 'text', text: '{"action":"fold","publicRationale":"script-fold"}' }] } },
      })
    },
    async whenIdle() {},
    session,
  }
}

export function createDshHost(input: { serverUrl: string; inviteCode: string }): DshHost {
  const credentials = new Map<string, string>()
  const ctx = {
    llm: {
      registerAdapter() {
        return Object.assign(() => undefined, { replace() {} })
      },
      listProviders: () => [
        { id: 'openai-compatible', name: 'Local' },
        { id: 'script', name: 'Script' },
      ],
      async listModels(provider: string) {
        if (provider === 'script') return [{ id: 'fold', name: 'fold' }]
        return [{ id: 'local-a', name: 'Local A' }, { id: 'local-b', name: 'Local B' }]
      },
      async * stream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', text: 'reward-ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agents: {
      async create() {
        return { agent: createFoldAgent(), async dispose() {} }
      },
    },
    connection: {
      rpc: {
        handle() {
          return async () => undefined
        },
      },
    },
    credentials: {
      async resolve(ref: unknown) {
        const value = credentials.get(String(ref))
        return value ? { value } : undefined
      },
      async set(ref: unknown, value: string) {
        credentials.set(String(ref), value)
      },
    },
    effect(fn: () => (() => void) | void) {
      return fn() ?? (() => undefined)
    },
    inject(_deps: string[], callback: (inner: typeof ctx) => void) {
      callback(ctx)
    },
  }

  apply(ctx, {
    serverUrl: input.serverUrl,
    inviteCode: input.inviteCode,
    allowUnverifiedDsh: true,
  })
  const runtime = runtimeOf(ctx)
  if (!runtime) throw new Error('apply() did not capture ArenaRuntime')

  return {
    runtime,
    async rpc(endpoint, payload = {}) {
      return handleArenaRpc(runtime, endpoint, payload)
    },
    async wait(pred, timeoutMs, label) {
      await runtime.store.waitUntil(() => pred(runtime), timeoutMs, label)
    },
    async streamReward(grant, messages = ['hello from winner']) {
      const adapter = new ArenaLlmAdapter(
        () => runtime.store.snapshot.grants as GrantV1[],
        (options, item) => runtime.streamGrant(options, item),
      )
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: PROVIDER_ID,
        model: grant.grantId,
        messages,
      } satisfies GenerateOptions)) {
        chunks.push(chunk)
      }
      return chunks
    },
    async dispose() {
      await runtime.dispose()
    },
  }
}

function launchedAsWorker(): boolean {
  const argv1 = process.argv[1] ?? ''
  return process.env.DSH_PLAYER === '1' || argv1.endsWith('dsh-player.ts') || argv1.endsWith('dsh-player.js')
}

if (launchedAsWorker()) {
  const serverUrl = process.env.ARENA_WS_URL ?? ''
  const inviteCode = process.env.ARENA_INVITE ?? ''
  const host = createDshHost({ serverUrl, inviteCode })
  const send = (payload: unknown) => {
    process.send?.(payload)
  }

  void host.wait((rt) => rt.store.snapshot.connectionState === 'ready', 20_000, 'auth')
    .then(() => send({ op: 'booted', deviceId: host.runtime.store.snapshot.deviceId }))
    .catch((error: unknown) => send({ op: 'boot_error', error: error instanceof Error ? error.message : String(error) }))

  process.on('message', async (msg: {
    id: number
    op: 'rpc' | 'snapshot' | 'stream' | 'wait' | 'dispose'
    endpoint?: string
    payload?: unknown
    timeoutMs?: number
    label?: string
    field?: string
  }) => {
    try {
      if (msg.op === 'rpc') {
        send({ id: msg.id, result: await host.rpc(msg.endpoint!, msg.payload) })
        return
      }
      if (msg.op === 'snapshot') {
        send({ id: msg.id, result: host.runtime.store.snapshot })
        return
      }
      if (msg.op === 'stream') {
        const grant = (host.runtime.store.snapshot.grants as GrantV1[])[0]
        if (!grant) throw new Error('no grant')
        send({ id: msg.id, result: await host.streamReward(grant) })
        return
      }
      if (msg.op === 'wait') {
        await host.wait((rt) => {
          const snap = rt.store.snapshot as unknown as Record<string, unknown>
          if (msg.field === 'roomCode') return Boolean(snap.roomCode)
          if (msg.field === 'result') return Boolean(snap.result)
          if (msg.field === 'grants') return Array.isArray(snap.grants) && (snap.grants as unknown[]).length > 0
          if (msg.field === 'ready') return snap.connectionState === 'ready'
          return false
        }, msg.timeoutMs ?? 30_000, msg.label ?? msg.field ?? 'wait')
        send({ id: msg.id, result: host.runtime.store.snapshot })
        return
      }
      if (msg.op === 'dispose') {
        await host.dispose()
        send({ id: msg.id, result: true })
        process.exit(0)
      }
    } catch (error) {
      send({ id: msg.id, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
