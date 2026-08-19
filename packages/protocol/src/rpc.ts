import { z } from 'zod'
import { grantSchema } from './grant.ts'

export const rpcEndpoints = [
  'bootstrap',
  'privacy.ack',
  'models.list',
  'match.local.start',
  'match.local.cancel',
  'room.create',
  'room.join',
  'room.accept',
  'room.leave',
  'match.snapshot',
  'grants.list',
  'grants.stream',
  'events.poll',
] as const

export type RpcEndpoint = (typeof rpcEndpoints)[number]

export const bootstrapResponseSchema = z.object({
  deviceId: z.string().nullable(),
  dshVersion: z.string(),
  compatible: z.literal(true),
  privacyAcknowledged: z.boolean(),
  serverReachable: z.boolean(),
  connectionState: z.enum(['idle', 'connecting', 'ready', 'reconnecting', 'offline']),
  ownerOnline: z.boolean(),
  grants: z.array(grantSchema),
})

export const modelsListResponseSchema = z.object({
  models: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    name: z.string(),
    allowedForStake: z.boolean(),
  })),
})

export const eventsPollRequestSchema = z.object({
  cursor: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(0).max(25_000).default(15_000),
})

export type UiSnapshot = Record<string, unknown>
