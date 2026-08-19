import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_REQUEST_BYTES,
  PROVIDER_ID,
  type Grant,
} from '@agent-colosseum/protocol'

export interface StreamChunk {
  type: 'block-start' | 'text-delta' | 'block-end' | 'usage' | 'finish'
  index?: number
  blockType?: string
  text?: string
  block?: { type: 'text'; text: string }
  usage?: { inputTokens: number; outputTokens: number }
  reason?: { kind: 'stop' | 'error' | 'aborted'; failure?: { message: string; code: string } }
}

export interface GenerateOptions {
  provider: string
  model: string
  messages: unknown[]
  maxTokens?: number
  signal?: AbortSignal
}

export abstract class LlmAdapterBase {
  providerInfo(provider: string) {
    return { id: provider, name: 'Agent Colosseum Grant' }
  }
  listModels(_provider: string): Promise<readonly { id: string; name: string }[]> {
    return Promise.resolve([])
  }
  resolveModel(provider: string, model: string): Promise<{
    provider: string
    id: string
    name: string
    defaultMaxTokens?: number
  }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export class ArenaLlmAdapter extends LlmAdapterBase {
  constructor(
    private readonly grants: () => Grant[],
    private readonly relay: (options: GenerateOptions, grant: Grant) => AsyncIterable<StreamChunk>,
  ) {
    super()
  }

  override async listModels(_provider: string) {
    return this.grants()
      .filter((grant) => grant.status === 'active' && grant.callsRemaining > 0)
      .map((grant) => ({
        id: grant.grantId,
        name: `${grant.model} · ${grant.callsRemaining} left`,
      }))
  }

  override async resolveModel(provider: string, model: string) {
    const grant = this.grants().find((item) => item.grantId === model)
    return {
      provider,
      id: model,
      name: grant ? `${grant.model} (${grant.ownerOnline ? 'owner online' : 'owner offline'})` : model,
      ...grant?.status === 'active' ? { defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS } : {},
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== PROVIDER_ID) {
      throw Object.assign(new Error('wrong provider'), { code: 'NO_ADAPTER' })
    }
    const grant = this.grants().find((item) => item.grantId === options.model)
    if (!grant || grant.status !== 'active') {
      yield* fail('GRANT_UNAVAILABLE', 'grant is not active')
      return
    }
    if (!grant.ownerOnline) {
      yield* fail('OWNER_OFFLINE', 'grant owner is offline; TTL is paused')
      return
    }
    if (grant.callsRemaining <= 0) {
      yield* fail('GRANT_EXHAUSTED', 'no calls remaining')
      return
    }
    const encoded = Buffer.byteLength(JSON.stringify(options.messages), 'utf8')
    if (encoded > MAX_REQUEST_BYTES) {
      yield* fail('REQUEST_TOO_LARGE', `serialized request ${encoded} exceeds ${MAX_REQUEST_BYTES}`)
      return
    }
    yield* this.relay(options, grant)
  }
}

async function* fail(code: string, message: string): AsyncIterable<StreamChunk> {
  yield {
    type: 'finish',
    reason: { kind: 'error', failure: { code, message } },
  }
}
