import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from './constants.ts'
import { parseClientFrame, ProtocolError, grantUpdatedPayloadSchema } from './frames.ts'
import { agentDecisionSchema, pokerActionSchema, pokerMatchStateSchema } from './poker-action.ts'
import { DeviceId, GrantId, InferenceId, InviteCode, MatchId, MessageId, RoomCode, RoomId, StakeId, newGrantId, newInferenceId, newInviteCode, newMatchId, newMessageId, newRoomCode, newRoomId, newStakeId, uuidv7 } from './ids.ts'
import { defaultStakeSpec, stakeCanonicalPayload, stakeSpecSchema } from './stake.ts'
import { grantSchema, inferenceCallSchema } from './grant.ts'
import { assertRequestLimits, estimateRequest, serializeModelRequest } from './estimate.ts'
import { failClosed } from './errors.ts'

function codeOf(fn: () => unknown): string {
  try {
    fn()
    throw new Error('expected throw')
  } catch (error) {
    return (error as ProtocolError).code
  }
}

function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: uuidv7(),
    sentAt: 1,
    type: 'session.heartbeat',
    payload: { at: 1 },
    ...overrides,
  }
}

describe('protocol fail-closed branches', () => {
  it('rejects null, missing fields, unsupported version, and unknown types', () => {
    expect(codeOf(() => parseClientFrame(null))).toBe('INVALID_FRAME')
    expect(codeOf(() => parseClientFrame('x'))).toBe('INVALID_FRAME')
    expect(codeOf(() => parseClientFrame(heartbeat({ protocolVersion: 9 })))).toBe('UNSUPPORTED_VERSION')
    expect(codeOf(() => parseClientFrame(heartbeat({ type: 'nope' })))).toBe('UNKNOWN_TYPE')
    expect(codeOf(() => parseClientFrame(heartbeat({ deviceId: uuidv7() })))).toBe('UNKNOWN_FIELD')
    expect(codeOf(() => parseClientFrame(heartbeat({ extra: true })))).toBe('INVALID_FRAME')
    expect(() => parseClientFrame({
      protocolVersion: PROTOCOL_VERSION,
      messageId: uuidv7(),
      sentAt: 1,
      type: 'session.heartbeat',
      payload: { at: 1 },
      correlationId: uuidv7(),
    })).not.toThrow()
  })

  it('parses every known client frame type', () => {
    const stake = defaultStakeSpec(uuidv7(), 'openai-compatible', 'm', 'n'.repeat(16), 'sig')
    const frames = [
      { type: 'auth.hello', payload: { ed25519PublicKey: 'e', x25519PublicKey: 'x', inviteCode: 'INVITECODE12' } },
      { type: 'auth.hello', payload: { ed25519PublicKey: 'e', x25519PublicKey: 'x' } },
      { type: 'auth.challenge_response', payload: { nonce: 'n', signature: 's' } },
      { type: 'auth.challenge_response', payload: { nonce: 'n', signature: 's', deviceId: uuidv7() } },
      { type: 'session.heartbeat', payload: { at: 1 } },
      { type: 'room.create', payload: { stake } },
      { type: 'room.join', payload: { roomCode: 'ABC234', stake } },
      { type: 'room.accept', payload: { roomId: uuidv7(), stake } },
      { type: 'room.leave', payload: { roomId: uuidv7() } },
      { type: 'match.entropy', payload: { matchId: uuidv7(), entropyHex: 'ab'.repeat(32), signature: 's' } },
      { type: 'match.action', payload: { matchId: uuidv7(), handNo: 1, actionSeq: 0, action: 'fold', publicRationale: 'x' } },
      { type: 'relay.reserve', payload: { grantId: uuidv7(), inferenceId: uuidv7(), ciphertext: 'aa', nonce: 'bb', estimatedInputTokens: 1, requestBytes: 8, requestHash: 'h' } },
      { type: 'relay.preflight_ok', payload: { grantId: uuidv7(), inferenceId: uuidv7(), requestHash: 'h' } },
      { type: 'relay.chunk', payload: { grantId: uuidv7(), inferenceId: uuidv7(), seq: 0, ciphertext: 'cc', nonce: 'dd' } },
      { type: 'relay.terminal', payload: { grantId: uuidv7(), inferenceId: uuidv7(), status: 'completed', usage: { inputTokens: 1, outputTokens: 1 } } },
      { type: 'relay.terminal', payload: { grantId: uuidv7(), inferenceId: uuidv7(), status: 'cancelled' } },
    ]
    for (const item of frames) {
      expect(parseClientFrame({
        protocolVersion: PROTOCOL_VERSION,
        messageId: uuidv7(),
        sentAt: Date.now(),
        type: item.type,
        payload: item.payload,
      }).type).toBe(item.type)
    }
  })

  it('validates agent decisions, actions, grants and estimates', () => {
    expect(() => agentDecisionSchema.parse({ action: 'raise', publicRationale: 'x' })).toThrow()
    expect(agentDecisionSchema.parse({ action: 'check', publicRationale: 'ok' }).action).toBe('check')
    expect(() => pokerActionSchema.parse({
      matchId: uuidv7(), handNo: 1, actionSeq: 0, action: 'raise', raiseTo: 4, publicRationale: 'x',
    })).not.toThrow()
    expect(serializeModelRequest({ messages: [] })).toMatch(/null/)
    expect(estimateRequest({ messages: [] }).estimatedInputTokens).toBeGreaterThan(0)
    expect(() => assertRequestLimits({ bytes: 1, estimatedInputTokens: 1 })).not.toThrow()
    expect(() => DeviceId('nope')).toThrow()
    expect(RoomId(newRoomId())).toBeTruthy()
    expect(MatchId(newMatchId())).toBeTruthy()
    expect(GrantId(newGrantId())).toBeTruthy()
    expect(StakeId(newStakeId())).toBeTruthy()
    expect(InferenceId(newInferenceId())).toBeTruthy()
    expect(MessageId(newMessageId())).toBeTruthy()
    expect(() => RoomCode('ABC')).toThrow()
    expect(() => RoomCode('ABC23I')).toThrow()
    expect(RoomCode(newRoomCode()).length).toBe(6)
    expect(() => InviteCode('short')).toThrow()
    expect(InviteCode(newInviteCode()).length).toBe(16)
    const grant = grantSchema.parse({
      grantId: uuidv7(), ownerDeviceId: uuidv7(), winnerDeviceId: uuidv7(),
      model: 'm', provider: 'p', callsRemaining: 1, activeConcurrency: 0, onlineMsRemaining: 1,
      ownerOnline: true, status: 'active', statusReason: 'active', version: 1,
    })
    expect(grantUpdatedPayloadSchema.parse(grant).grantId).toBe(grant.grantId)
    expect(inferenceCallSchema.parse({
      grantId: uuidv7(), inferenceId: uuidv7(), requesterDeviceId: uuidv7(), ownerDeviceId: uuidv7(),
      status: 'reserved', deducted: false, requestHash: 'h', startedAt: null, finishedAt: null, terminalReason: null,
    }).status).toBe('reserved')
    expect(stakeSpecSchema.parse(defaultStakeSpec(uuidv7(), 'openai-compatible', 'm', 'n'.repeat(16), 's')).model).toBe('m')
    expect(stakeCanonicalPayload(defaultStakeSpec(uuidv7(), 'p', 'm', 'n'.repeat(16), 's'))).toMatch(/ownerDeviceId/)
    expect(() => failClosed('OLD_SCHEMA', 'old')).toThrow(ProtocolError)
    expect(() => pokerMatchStateSchema.parse({ schemaVersion: 2 })).toThrow()
  })
})
