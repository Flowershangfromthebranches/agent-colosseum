import { z } from 'zod'
import { PROTOCOL_VERSION } from './constants.ts'
import { grantSchema } from './grant.ts'
import { pokerActionSchema } from './poker-action.ts'
import { stakeSpecSchema } from './stake.ts'

export const arenaFrameBaseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.string().uuid(),
  deviceId: z.string().uuid(),
  type: z.string(),
  payload: z.unknown(),
})

export type ArenaFrameV1<T extends string = string, P = unknown> = {
  protocolVersion: typeof PROTOCOL_VERSION
  messageId: string
  deviceId: string
  type: T
  payload: P
}

const frame = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    messageId: z.string().uuid(),
    deviceId: z.string().uuid(),
    type: z.literal(type),
    payload,
  })

export const helloFrameSchema = frame('auth.hello', z.object({
  inviteCode: z.string().min(10).optional(),
  ed25519PublicKey: z.string().min(1),
  x25519PublicKey: z.string().min(1),
}))

export const challengeFrameSchema = frame('auth.challenge', z.object({
  nonce: z.string().min(1),
  expiresAt: z.number().int(),
}))

export const challengeResponseFrameSchema = frame('auth.challenge_response', z.object({
  nonce: z.string().min(1),
  signature: z.string().min(1),
}))

export const sessionGrantedFrameSchema = frame('auth.session', z.object({
  sessionToken: z.string().min(1),
  deviceId: z.string().uuid(),
}))

export const roomCreateFrameSchema = frame('room.create', z.object({
  stake: stakeSpecSchema,
}))

export const roomJoinFrameSchema = frame('room.join', z.object({
  roomCode: z.string().length(6),
  stake: stakeSpecSchema,
}))

export const roomAcceptFrameSchema = frame('room.accept', z.object({
  roomId: z.string().uuid(),
}))

export const roomLeaveFrameSchema = frame('room.leave', z.object({
  roomId: z.string().uuid(),
}))

export const matchActionFrameSchema = frame('match.action', pokerActionSchema)

export const heartbeatFrameSchema = frame('session.heartbeat', z.object({
  at: z.number().int(),
}))

export const relayReserveFrameSchema = frame('relay.reserve', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  estimatedInputTokens: z.number().int().nonnegative(),
  requestBytes: z.number().int().positive().max(65_536),
}))

export const relayPreflightOkFrameSchema = frame('relay.preflight_ok', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
}))

export const relayInferenceStartedFrameSchema = frame('relay.inference_started', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
}))

export const relayChunkFrameSchema = frame('relay.chunk', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
}))

export const relayTerminalFrameSchema = frame('relay.terminal', z.object({
  grantId: z.string().uuid(),
  inferenceId: z.string().uuid(),
  status: z.enum(['completed', 'cancelled', 'owner_offline', 'provider_error', 'aborted']),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }).optional(),
}))

export const grantUpdatedFrameSchema = frame('grant.updated', grantSchema)

export const knownFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  challengeFrameSchema,
  challengeResponseFrameSchema,
  sessionGrantedFrameSchema,
  roomCreateFrameSchema,
  roomJoinFrameSchema,
  roomAcceptFrameSchema,
  roomLeaveFrameSchema,
  matchActionFrameSchema,
  heartbeatFrameSchema,
  relayReserveFrameSchema,
  relayPreflightOkFrameSchema,
  relayInferenceStartedFrameSchema,
  relayChunkFrameSchema,
  relayTerminalFrameSchema,
  grantUpdatedFrameSchema,
])

export type KnownFrame = z.infer<typeof knownFrameSchema>

export function parseArenaFrame(input: unknown): KnownFrame {
  const base = arenaFrameBaseSchema.safeParse(input)
  if (!base.success) {
    throw new ProtocolError('INVALID_FRAME', 'frame failed base validation', base.error.flatten())
  }
  if (base.data.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolError('UNSUPPORTED_VERSION', `unsupported protocolVersion ${String(base.data.protocolVersion)}`)
  }
  const parsed = knownFrameSchema.safeParse(input)
  if (!parsed.success) {
    throw new ProtocolError('UNKNOWN_OR_INVALID_TYPE', `unknown or invalid frame type ${base.data.type}`, parsed.error.flatten())
  }
  return parsed.data
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}
