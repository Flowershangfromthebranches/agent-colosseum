import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from './constants.ts'
import { ProtocolError } from './errors.ts'
import { parseClientFrame } from './frames.ts'
import { DeviceId, isUuidV7, newDeviceId, newRoomCode, RoomCode, uuidv7 } from './ids.ts'
import { defaultStakeSpec, stakeTermsFingerprint } from './stake.ts'

describe('ids', () => {
  it('mints UUIDv7 and Crockford room codes', () => {
    expect(isUuidV7(uuidv7())).toBe(true)
    expect(() => DeviceId(newDeviceId())).not.toThrow()
    expect(() => DeviceId('nope')).toThrow(/UUIDv7/)
    const code = newRoomCode()
    expect(RoomCode(code)).toBe(code)
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
    })).toThrow(/INVALID_FRAME|UNSUPPORTED_VERSION|base validation/)

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

describe('stake terms', () => {
  it('ignores provider and model when comparing terms', () => {
    const a = defaultStakeSpec(uuidv7(), 'openai-compatible', 'qwen', 'n1', 's')
    const b = defaultStakeSpec(uuidv7(), 'script', 'other', 'n2', 's')
    expect(stakeTermsFingerprint(a)).toBe(stakeTermsFingerprint(b))
  })
})
