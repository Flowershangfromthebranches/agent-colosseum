import { describe, expect, it } from 'vitest'
import { DeviceId, isUuidV7, newDeviceId, newRoomCode, RoomCode, uuidv7 } from './ids.ts'
import { parseArenaFrame, ProtocolError } from './frames.ts'
import { PROTOCOL_VERSION } from './constants.ts'

describe('ids', () => {
  it('mints UUIDv7', () => {
    const id = uuidv7()
    expect(isUuidV7(id)).toBe(true)
    expect(() => DeviceId(id)).not.toThrow()
    expect(() => DeviceId('not-a-uuid')).toThrow(/UUIDv7/)
    expect(newDeviceId()).toMatch(/-7[0-9a-f]{3}-/)
  })

  it('validates room codes', () => {
    const code = newRoomCode()
    expect(code).toHaveLength(6)
    expect(RoomCode(code)).toBe(code)
    expect(() => RoomCode('abc')).toThrow()
  })
})

describe('frames', () => {
  it('rejects unknown versions and types', () => {
    expect(() => parseArenaFrame({
      protocolVersion: 99,
      messageId: uuidv7(),
      deviceId: uuidv7(),
      type: 'auth.hello',
      payload: {},
    })).toThrow(ProtocolError)

    expect(() => parseArenaFrame({
      protocolVersion: PROTOCOL_VERSION,
      messageId: uuidv7(),
      deviceId: uuidv7(),
      type: 'not.a.frame',
      payload: {},
    })).toThrow(/unknown or invalid/)
  })

  it('accepts a heartbeat', () => {
    const frame = parseArenaFrame({
      protocolVersion: PROTOCOL_VERSION,
      messageId: uuidv7(),
      deviceId: uuidv7(),
      type: 'session.heartbeat',
      payload: { at: Date.now() },
    })
    expect(frame.type).toBe('session.heartbeat')
  })
})
