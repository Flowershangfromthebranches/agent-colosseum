import {
  deriveSharedKey,
  openJson,
  relayAad,
  sealJson,
  sha256Hex,
  type DeviceKeypair,
} from '@agent-colosseum/crypto'
import {
  assertRequestLimits,
  estimateRequest,
  newInferenceId,
  type GrantV1,
} from '@agent-colosseum/protocol'
import type { GenerateOptions, StreamChunk } from './llm-adapter.ts'

export interface GrantLedger {
  reserve(input: {
    grantId: string
    inferenceId: string
    winnerDeviceId: string
    requestBytes: number
    requestHash: string
    ownerOnline: boolean
  }): Promise<{ grant: GrantV1 }>
  preflight(grantId: string, inferenceId: string, requestHash: string): Promise<unknown>
  start(grantId: string, inferenceId: string): Promise<GrantV1>
  terminal(
    grantId: string,
    inferenceId: string,
    status: 'completed' | 'cancelled' | 'provider_error' | 'aborted',
    reason?: string,
  ): Promise<unknown>
}

export interface OwnerLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface GrantPeer {
  deviceId: string
  keys: DeviceKeypair
}

export function measureGenerateOptions(options: GenerateOptions) {
  return estimateRequest({
    messages: options.messages,
    tools: (options as { tools?: unknown }).tools,
    stop: (options as { stop?: unknown }).stop,
    callConfig: { maxTokens: options.maxTokens },
  })
}

export function requestHashOf(options: GenerateOptions): string {
  return sha256Hex(JSON.stringify({
    messages: options.messages,
    maxTokens: options.maxTokens ?? null,
  }))
}

export function sealWinnerRequest(input: {
  winnerPrivate: string
  ownerPublic: string
  grantId: string
  inferenceId: string
  options: GenerateOptions
}) {
  const shared = deriveSharedKey(input.winnerPrivate, input.ownerPublic)
  return {
    shared,
    box: sealJson(shared, input.options, relayAad({
      grantId: input.grantId,
      inferenceId: input.inferenceId,
      seq: 0,
      direction: 'winner_to_owner',
    })),
  }
}

export function openWinnerRequest(input: {
  ownerPrivate: string
  winnerPublic: string
  grantId: string
  inferenceId: string
  box: { nonce: string; ciphertext: string }
}): GenerateOptions {
  const shared = deriveSharedKey(input.ownerPrivate, input.winnerPublic)
  return openJson<GenerateOptions>(shared, input.box, relayAad({
    grantId: input.grantId,
    inferenceId: input.inferenceId,
    seq: 0,
    direction: 'winner_to_owner',
  }))
}

export function ownerRoutedOptions(grant: GrantV1, opened: GenerateOptions, signal?: AbortSignal): GenerateOptions {
  measureGenerateOptions(opened)
  assertRequestLimits(measureGenerateOptions(opened), opened.maxTokens)
  return {
    ...opened,
    provider: grant.provider,
    model: grant.model,
    ...signal ? { signal } : {},
  }
}

/**
 * Product Grant path used by the Host adapter and tests:
 * reserve → owner preflight → started → AAD-sealed chunks → terminal.
 * Owner always streams grant.provider/grant.model (request cannot override).
 */
export async function* streamGrantThroughOwner(input: {
  grant: GrantV1
  options: GenerateOptions
  winner: GrantPeer
  owner: GrantPeer
  ownerLlm: OwnerLlm
  ledger: GrantLedger
  ownerOnline: boolean
}): AsyncIterable<StreamChunk> {
  const inferenceId = newInferenceId()
  const estimate = measureGenerateOptions(input.options)
  assertRequestLimits(estimate, input.options.maxTokens)
  const hash = requestHashOf(input.options)
  const { shared, box } = sealWinnerRequest({
    winnerPrivate: input.winner.keys.x25519PrivateKey,
    ownerPublic: input.owner.keys.x25519PublicKey,
    grantId: input.grant.grantId,
    inferenceId,
    options: input.options,
  })
  const reserved = await input.ledger.reserve({
    grantId: input.grant.grantId,
    inferenceId,
    winnerDeviceId: input.winner.deviceId,
    requestBytes: estimate.bytes,
    requestHash: hash,
    ownerOnline: input.ownerOnline,
  })
  if (reserved.grant.ownerDeviceId !== input.owner.deviceId) throw new Error('UNAUTHORIZED')

  const opened = openWinnerRequest({
    ownerPrivate: input.owner.keys.x25519PrivateKey,
    winnerPublic: input.winner.keys.x25519PublicKey,
    grantId: input.grant.grantId,
    inferenceId,
    box,
  })
  const routed = ownerRoutedOptions(input.grant, opened, input.options.signal)
  await input.ledger.preflight(input.grant.grantId, inferenceId, hash)
  await input.ledger.start(input.grant.grantId, inferenceId)

  let terminal: 'completed' | 'cancelled' | 'provider_error' | 'aborted' = 'completed'
  try {
    if (input.options.signal?.aborted) {
      terminal = 'aborted'
      throw new Error('aborted')
    }
    let seq = 1
    try {
      for await (const chunk of input.ownerLlm.stream(routed)) {
        if (input.options.signal?.aborted) {
          terminal = 'cancelled'
          break
        }
        const sealed = sealJson(shared, chunk, relayAad({
          grantId: input.grant.grantId,
          inferenceId,
          seq,
          direction: 'owner_to_winner',
        }))
        yield openJson<StreamChunk>(shared, sealed, relayAad({
          grantId: input.grant.grantId,
          inferenceId,
          seq,
          direction: 'owner_to_winner',
        }))
        seq += 1
      }
    } catch (error) {
      terminal = input.options.signal?.aborted ? 'aborted' : 'provider_error'
      throw error
    }
    if (input.options.signal?.aborted) terminal = 'cancelled'
  } finally {
    await input.ledger.terminal(input.grant.grantId, inferenceId, terminal)
  }
}
