import { z } from 'zod'
import { PROTOCOL_VERSION } from './constants.ts'
import { failClosed, ProtocolError } from './errors.ts'
import { grantSchema } from './grant.ts'
import { pokerActionSchema } from './poker-action.ts'
import { stakeSpecSchema } from './stake.ts'

export const clientFrameBaseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.string().uuid(),
  correlationId: z.string().uuid().optional(),
  sentAt: z.number().int(),
  type: z.string(),
  payload: z.unknown(),
}).strict()

export type ArenaClientFrameV1<T extends string = string, P = unknown> = {
  protocolVersion: typeof PROTOCOL_VERSION
  messageId: string
  correlationId?: string
  sentAt: number
  type: T
  payload: P
}

const client = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    messageId: z.string().uuid(),
    correlationId: z.string().uuid().optional(),
    sentAt: z.number().int(),
    type: z.literal(type),
    payload,
  }).strict()

export const helloFrameSchema = client('auth.hello', z.object({
  inviteCode: z.string().min(10).max(32).optional(),
  ed25519PublicKey: z.string().min(1),
  x25519PublicKey: z.string().min(1),
}).strict())

export const challengeResponseFrameSchema = client('auth.challenge_response', z.object({
  nonce: z.string().min(1),
  signature: z.string().min(1),
  deviceId: z.string().uuid().optional(),
}).strict())

export const heartbeatFrameSchema = client('session.heartbeat', z.object({
  at: z.number().int(),
}).strict())

export const roomCreateFrameSchema = client('room.create', z.object({
  stake: stakeSpecSchema,
}).strict())

export const roomJoinFrameSchema = client('room.join', z.object({
  roomCode: z.string().length(6),
  stake: stakeSpecSchema,
}).strict())

export const roomAcceptFrameSchema = client('room.accept', z.object({
  roomId: z.string().uuid(),
  stake: stakeSpecSchema,
}).strict())

export const roomLeaveFrameSchema = client('room.leave', z.object({
  roomId: z.string().uuid(),
}).strict())

export const entropyFrameSchema = client('match.entropy', z.object({
  matchId: z.string().uuid(),
  entropyHex: z.string().min(64),
  signature: z.string().min(1),
}).strict())

export const matchActionFrameSchema = client('match.action', pokerActionSchema)

export const relayReserveFrameSchema = client('relay.reserve', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  estimatedInputTokens: z.number().int().nonnegative(),
  requestBytes: z.number().int().positive().max(65_536),
  requestHash: z.string().min(1),
}).strict())

export const relayPreflightOkFrameSchema = client('relay.preflight_ok', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  requestHash: z.string().min(1),
}).strict())

export const relayChunkFrameSchema = client('relay.chunk', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
}).strict())

export const relayTerminalFrameSchema = client('relay.terminal', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  status: z.enum(['completed', 'cancelled', 'owner_offline', 'provider_error', 'aborted']),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict())

export const knownClientFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  challengeResponseFrameSchema,
  heartbeatFrameSchema,
  roomCreateFrameSchema,
  roomJoinFrameSchema,
  roomAcceptFrameSchema,
  roomLeaveFrameSchema,
  entropyFrameSchema,
  matchActionFrameSchema,
  relayReserveFrameSchema,
  relayPreflightOkFrameSchema,
  relayChunkFrameSchema,
  relayTerminalFrameSchema,
])

export type KnownClientFrame = z.infer<typeof knownClientFrameSchema>

export function parseClientFrame(input: unknown): KnownClientFrame {
  if (typeof input !== 'object' || input === null) failClosed('INVALID_FRAME', 'frame is not an object')
  const raw = input as Record<string, unknown>
  if ('deviceId' in raw) failClosed('UNKNOWN_FIELD', 'client frames must not carry deviceId')
  const base = clientFrameBaseSchema.safeParse(input)
  if (!base.success) failClosed('INVALID_FRAME', 'frame failed base validation', base.error.flatten())
  if (base.data.protocolVersion !== PROTOCOL_VERSION) {
    failClosed('UNSUPPORTED_VERSION', `unsupported protocolVersion ${String(base.data.protocolVersion)}`)
  }
  const parsed = knownClientFrameSchema.safeParse(input)
  if (!parsed.success) failClosed('UNKNOWN_TYPE', `unknown or invalid frame type ${base.data.type}`, parsed.error.flatten())
  return parsed.data
}

export const serverEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.string().uuid(),
  correlationId: z.string().uuid().optional(),
  sentAt: z.number().int(),
  type: z.string(),
  payload: z.unknown(),
})

export const grantUpdatedPayloadSchema = grantSchema
export { ProtocolError }
