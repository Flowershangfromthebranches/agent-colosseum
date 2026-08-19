import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from './constants.ts'
import { ProtocolError } from './errors.ts'
import { parseClientFrame } from './frames.ts'
import { DeviceId, InviteCode, isUuidV7, newDeviceId, newInviteCode, newRoomCode, RoomCode, uuidv7 } from './ids.ts'
import { pokerActionSchema } from './poker-action.ts'
import { defaultStakeSpec, stakeTermsFingerprint } from './stake.ts'

describe('ids', () => {
  it('mints UUIDv7 and Crockford room codes', () => {
    expect(isUuidV7(uuidv7())).toBe(true)
    expect(() => DeviceId(newDeviceId())).not.toThrow()
    expect(() => DeviceId('nope')).toThrow(/UUIDv7/)
    const code = newRoomCode()
    expect(RoomCode(code)).toBe(code)
    const invite = newInviteCode()
    expect(InviteCode(invite)).toBe(invite)
    expect(() => InviteCode('nope')).toThrow()
  })
})

describe('frames', () => {
  it('rejects deviceId, unknown versions, unknown types, extra fields', () => {
    expect(() => parseClientFrame({
      protocolVersion: PROTOCOL_VERSION,
      messageId: uuidv7(),
      sentAt: 1,
      type: 'session.heartbeat',
      payload: { at: 1 },
      deviceId: uuidv7(),
    })).toThrow(ProtocolError)

    expect(() => parseClientFrame({
      protocolVersion: 9,
      messageId: uuidv7(),
      sentAt: 1,
      type: 'session.heartbeat',
      payload: { at: 1 },
    })).toThrow(/unsupported protocolVersion 9/)

    expect(() => parseClientFrame({
      protocolVersion: PROTOCOL_VERSION,
      messageId: uuidv7(),
      sentAt: 1,
      type: 'nope',
      payload: {},
    })).toThrow(/UNKNOWN_TYPE|unknown/)

    expect(() => parseClientFrame({
      protocolVersion: PROTOCOL_VERSION,
      messageId: uuidv7(),
      sentAt: 1,
      type: 'session.heartbeat',
      payload: { at: 1 },
      extra: true,
    })).toThrow()
  })

  it('accepts a strict heartbeat', () => {
    const frame = parseClientFrame({
      protocolVersion: PROTOCOL_VERSION,
      messageId: uuidv7(),
      sentAt: Date.now(),
      type: 'session.heartbeat',
      payload: { at: Date.now() },
    })
    expect(frame.type).toBe('session.heartbeat')
  })
})

describe('request estimate', () => {
  it('counts system, messages, tools, stop and call config and rejects oversize', async () => {
    const { assertRequestLimits, estimateRequest } = await import('./estimate.ts')
    const small = estimateRequest({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'none' }],
      stop: ['END'],
      callConfig: { maxTokens: 16 },
    })
    expect(small.bytes).toBeGreaterThan(10)
    expect(small.estimatedInputTokens).toBeGreaterThan(0)
    expect(() => assertRequestLimits({ bytes: 70_000, estimatedInputTokens: 1 })).toThrow(/REQUEST_TOO_LARGE/)
    expect(() => assertRequestLimits({ bytes: 10, estimatedInputTokens: 20_000 })).toThrow(/INPUT_TOO_LARGE/)
    expect(() => assertRequestLimits({ bytes: 10, estimatedInputTokens: 1 }, 5000)).toThrow(/MAX_TOKENS/)
  })
})

describe('poker actions', () => {
  it('requires raiseTo only on raise', () => {
    expect(() => pokerActionSchema.parse({
      matchId: uuidv7(), handNo: 1, actionSeq: 0, action: 'raise', publicRationale: 'x',
    })).toThrow()
    expect(() => pokerActionSchema.parse({
      matchId: uuidv7(), handNo: 1, actionSeq: 0, action: 'fold', raiseTo: 4, publicRationale: 'x',
    })).toThrow()
    expect(pokerActionSchema.parse({
      matchId: uuidv7(), handNo: 1, actionSeq: 0, action: 'fold', publicRationale: 'x',
    }).action).toBe('fold')
  })
})

describe('stake terms', () => {
  it('ignores provider and model when comparing terms', () => {
    const a = defaultStakeSpec(uuidv7(), 'openai-compatible', 'qwen', 'n1', 's')
    const b = defaultStakeSpec(uuidv7(), 'script', 'other', 'n2', 's')
    expect(stakeTermsFingerprint(a)).toBe(stakeTermsFingerprint(b))
  })
})
