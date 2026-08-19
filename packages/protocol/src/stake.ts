import { z } from 'zod'
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_ESTIMATED_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  GRANT_ONLINE_TTL_SECONDS,
  MAX_REQUEST_BYTES,
} from './constants.ts'

export const stakeSpecSchema = z.object({
  ownerDeviceId: z.string().uuid(),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  maxCalls: z.literal(DEFAULT_MAX_CALLS),
  maxEstimatedInputTokens: z.literal(DEFAULT_MAX_ESTIMATED_INPUT_TOKENS),
  maxRequestBytes: z.literal(MAX_REQUEST_BYTES),
  maxOutputTokens: z.literal(DEFAULT_MAX_OUTPUT_TOKENS),
  maxConcurrency: z.literal(DEFAULT_MAX_CONCURRENCY),
  onlineTtlSeconds: z.literal(GRANT_ONLINE_TTL_SECONDS),
  signature: z.string().min(1),
})

export type StakeSpec = z.infer<typeof stakeSpecSchema>

export function defaultStakeSpec(
  ownerDeviceId: string,
  provider: string,
  model: string,
  signature: string,
): StakeSpec {
  return {
    ownerDeviceId,
    provider,
    model,
    maxCalls: DEFAULT_MAX_CALLS,
    maxEstimatedInputTokens: DEFAULT_MAX_ESTIMATED_INPUT_TOKENS,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    onlineTtlSeconds: GRANT_ONLINE_TTL_SECONDS,
    signature,
  }
}

export function stakeFingerprint(spec: Omit<StakeSpec, 'ownerDeviceId' | 'signature'>): string {
  return [
    spec.provider,
    spec.model,
    spec.maxCalls,
    spec.maxEstimatedInputTokens,
    spec.maxRequestBytes,
    spec.maxOutputTokens,
    spec.maxConcurrency,
    spec.onlineTtlSeconds,
  ].join(':')
}
