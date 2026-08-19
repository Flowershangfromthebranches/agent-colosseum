import { z } from 'zod'
import { GRANT_STATUSES } from './constants.ts'

export const grantSchema = z.object({
  grantId: z.string().uuid(),
  ownerDeviceId: z.string().uuid(),
  winnerDeviceId: z.string().uuid(),
  model: z.string().min(1),
  provider: z.string().min(1),
  callsRemaining: z.number().int().nonnegative(),
  onlineMsRemaining: z.number().int().nonnegative(),
  ownerOnline: z.boolean(),
  status: z.enum(GRANT_STATUSES),
  version: z.number().int().positive(),
})

export type Grant = z.infer<typeof grantSchema>
