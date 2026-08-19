import { DEFAULT_MAX_ESTIMATED_INPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, MAX_REQUEST_BYTES } from './constants.ts'

export interface EstimatedRequest {
  bytes: number
  estimatedInputTokens: number
}

export function serializeModelRequest(input: {
  system?: unknown
  messages: unknown
  tools?: unknown
  stop?: unknown
  callConfig?: unknown
}): string {
  return JSON.stringify({
    system: input.system ?? null,
    messages: input.messages,
    tools: input.tools ?? null,
    stop: input.stop ?? null,
    callConfig: input.callConfig ?? null,
  })
}

export function estimateRequest(input: {
  system?: unknown
  messages: unknown
  tools?: unknown
  stop?: unknown
  callConfig?: unknown
}): EstimatedRequest {
  const body = serializeModelRequest(input)
  return {
    bytes: new TextEncoder().encode(body).length,
    estimatedInputTokens: Math.ceil(body.length / 4) + 16,
  }
}

export function assertRequestLimits(estimate: EstimatedRequest, maxTokens?: number): void {
  if (estimate.bytes > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE')
  if (estimate.estimatedInputTokens > DEFAULT_MAX_ESTIMATED_INPUT_TOKENS) throw new Error('INPUT_TOO_LARGE')
  if (maxTokens !== undefined && maxTokens > DEFAULT_MAX_OUTPUT_TOKENS) throw new Error('MAX_TOKENS_EXCEEDED')
}
