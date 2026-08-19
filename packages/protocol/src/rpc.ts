import { z } from 'zod'
import { grantSchema } from './grant.ts'
import { stakeSpecSchema } from './stake.ts'

export const rpcEndpoints = [
  'bootstrap',
  'room.create',
  'room.join',
  'room.accept',
  'room.leave',
  'match.snapshot',
  'match.local.start',
  'match.local.action',
  'grants.list',
  'events.poll',
  'privacy.ack',
] as const

export type RpcEndpoint = (typeof rpcEndpoints)[number]

export const bootstrapRequestSchema = z.object({
  serverUrl: z.string().optional(),
  inviteCode: z.string().optional(),
})

export const bootstrapResponseSchema = z.object({
  deviceId: z.string().uuid(),
  dshVersion: z.string(),
  compatible: z.literal(true),
  privacyAcknowledged: z.boolean(),
  serverReachable: z.boolean(),
  ownerOnline: z.boolean(),
  grants: z.array(grantSchema),
  localModels: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    name: z.string(),
    allowedForStake: z.boolean(),
  })),
})

export const roomCreateRequestSchema = z.object({
  stake: stakeSpecSchema,
})

export const roomJoinRequestSchema = z.object({
  roomCode: z.string().length(6),
  stake: stakeSpecSchema,
})

export const roomIdRequestSchema = z.object({
  roomId: z.string().uuid(),
})

export const matchSnapshotRequestSchema = z.object({
  matchId: z.string().optional(),
})

export const eventsPollRequestSchema = z.object({
  cursor: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(0).max(25_000).default(15_000),
})

export type UiEvent =
  | { kind: 'state'; cursor: number; state: Record<string, unknown> }
  | { kind: 'toast'; cursor: number; level: 'info' | 'warn' | 'error'; message: string }

export const eventsPollResponseSchema = z.object({
  cursor: z.number().int().nonnegative(),
  events: z.array(z.object({
    kind: z.enum(['state', 'toast']),
    cursor: z.number().int(),
    level: z.enum(['info', 'warn', 'error']).optional(),
    message: z.string().optional(),
    state: z.record(z.unknown()).optional(),
  })),
})
