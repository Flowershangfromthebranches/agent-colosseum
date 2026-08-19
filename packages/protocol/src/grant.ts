import { z } from 'zod'
import { GRANT_STATUS_REASONS, GRANT_STATUSES } from './constants.ts'

export const grantSchema = z.object({
  grantId: z.string().uuid(),
  ownerDeviceId: z.string().uuid(),
  winnerDeviceId: z.string().uuid(),
  model: z.string().min(1),
  provider: z.string().min(1),
  callsRemaining: z.number().int().nonnegative(),
  activeConcurrency: z.number().int().nonnegative(),
  onlineMsRemaining: z.number().int().nonnegative(),
  ownerOnline: z.boolean(),
  status: z.enum(GRANT_STATUSES),
  statusReason: z.enum(GRANT_STATUS_REASONS),
  version: z.number().int().positive(),
})

export type GrantV1 = z.infer<typeof grantSchema>
export type Grant = GrantV1

export const inferenceCallSchema = z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  requesterDeviceId: z.string().uuid(),
  ownerDeviceId: z.string().uuid(),
  status: z.enum(['reserved', 'preflight', 'started', 'completed', 'cancelled', 'provider_error', 'aborted']),
  deducted: z.boolean(),
  requestHash: z.string().min(1),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  terminalReason: z.string().nullable(),
})

export type InferenceCallV1 = z.infer<typeof inferenceCallSchema>
