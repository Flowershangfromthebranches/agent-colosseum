import { z } from 'zod'
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_ESTIMATED_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  GRANT_ONLINE_TTL_SECONDS,
  MAX_REQUEST_BYTES,
} from './constants.ts'

export const stakeLimitsSchema = z.object({
  maxCalls: z.literal(DEFAULT_MAX_CALLS),
  maxEstimatedInputTokens: z.literal(DEFAULT_MAX_ESTIMATED_INPUT_TOKENS),
  maxRequestBytes: z.literal(MAX_REQUEST_BYTES),
  maxOutputTokens: z.literal(DEFAULT_MAX_OUTPUT_TOKENS),
  maxConcurrency: z.literal(DEFAULT_MAX_CONCURRENCY),
  onlineTtlSeconds: z.literal(GRANT_ONLINE_TTL_SECONDS),
})

export const stakeSpecSchema = stakeLimitsSchema.extend({
  ownerDeviceId: z.string().uuid(),
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  nonce: z.string().min(16),
  signature: z.string().min(1),
})

export type StakeSpecV1 = z.infer<typeof stakeSpecSchema>
export type StakeSpec = StakeSpecV1

export function defaultStakeLimits() {
  return {
    maxCalls: DEFAULT_MAX_CALLS,
    maxEstimatedInputTokens: DEFAULT_MAX_ESTIMATED_INPUT_TOKENS,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    onlineTtlSeconds: GRANT_ONLINE_TTL_SECONDS,
  } as const
}

export function defaultStakeSpec(
  ownerDeviceId: string,
  provider: string,
  model: string,
  nonce: string,
  signature: string,
): StakeSpecV1 {
  return {
    ownerDeviceId,
    provider,
    model,
    ...defaultStakeLimits(),
    nonce,
    signature,
  }
}

export function stakeTermsFingerprint(spec: Pick<StakeSpecV1,
  'maxCalls' | 'maxEstimatedInputTokens' | 'maxRequestBytes' | 'maxOutputTokens' | 'maxConcurrency' | 'onlineTtlSeconds'
>): string {
  return [
    spec.maxCalls,
    spec.maxEstimatedInputTokens,
    spec.maxRequestBytes,
    spec.maxOutputTokens,
    spec.maxConcurrency,
    spec.onlineTtlSeconds,
  ].join(':')
}

export function stakeCanonicalPayload(spec: Omit<StakeSpecV1, 'signature'>): string {
  return JSON.stringify({
    ownerDeviceId: spec.ownerDeviceId,
    provider: spec.provider,
    model: spec.model,
    maxCalls: spec.maxCalls,
    maxEstimatedInputTokens: spec.maxEstimatedInputTokens,
    maxRequestBytes: spec.maxRequestBytes,
    maxOutputTokens: spec.maxOutputTokens,
    maxConcurrency: spec.maxConcurrency,
    onlineTtlSeconds: spec.onlineTtlSeconds,
    nonce: spec.nonce,
  })
}
