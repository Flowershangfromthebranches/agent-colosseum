import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_REQUEST_BYTES,
  PROVIDER_ID,
  type GrantV1,
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

export class ArenaLlmAdapter {
  constructor(
    private readonly grants: () => GrantV1[],
    private readonly relay: (options: GenerateOptions, grant: GrantV1) => AsyncIterable<StreamChunk>,
  ) {}

  providerInfo(provider: string) {
    return { id: provider, name: 'Agent Colosseum Grant' }
  }

  async listModels(_provider: string) {
    return this.grants()
      .filter((grant) => grant.status === 'active' && grant.callsRemaining > 0)
      .map((grant) => ({
        id: grant.grantId,
        name: `${grant.model} · ${grant.callsRemaining} left · ${grant.ownerOnline ? 'online' : 'offline'}`,
      }))
  }

  async resolveModel(provider: string, model: string) {
    const grant = this.grants().find((item) => item.grantId === model)
    return {
      provider,
      id: model,
      name: grant ? `${grant.model} (${grant.ownerOnline ? 'owner online' : 'owner offline'})` : model,
      ...grant?.status === 'active' ? { defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS } : {},
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== PROVIDER_ID) throw Object.assign(new Error('wrong provider'), { code: 'NO_ADAPTER' })
    const grant = this.grants().find((item) => item.grantId === options.model)
    if (!grant || grant.status !== 'active') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'GRANT_UNAVAILABLE', message: 'grant is not active' } } }
      return
    }
    if (!grant.ownerOnline) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'OWNER_OFFLINE', message: 'grant owner is offline; TTL is paused' } } }
      return
    }
    if (grant.callsRemaining <= 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'GRANT_EXHAUSTED', message: 'no calls remaining' } } }
      return
    }
    if (options.maxTokens !== undefined && options.maxTokens > DEFAULT_MAX_OUTPUT_TOKENS) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MAX_TOKENS_EXCEEDED', message: 'maxTokens exceeds 4096' } } }
      return
    }
    const encoded = Buffer.byteLength(JSON.stringify(options.messages), 'utf8')
    if (encoded > MAX_REQUEST_BYTES) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'REQUEST_TOO_LARGE', message: 'serialized request too large' } } }
      return
    }
    yield* this.relay(options, grant)
  }
}
