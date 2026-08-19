export type Brand<T, B extends string> = T & { readonly __brand: B }

export type DeviceId = Brand<string, 'DeviceId'>
export type RoomId = Brand<string, 'RoomId'>
export type MatchId = Brand<string, 'MatchId'>
export type GrantId = Brand<string, 'GrantId'>
export type StakeId = Brand<string, 'StakeId'>
export type InferenceId = Brand<string, 'InferenceId'>
export type MessageId = Brand<string, 'MessageId'>
export type InviteCode = Brand<string, 'InviteCode'>
export type RoomCode = Brand<string, 'RoomCode'>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]+$/
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const ms = BigInt(Date.now())
  bytes[0] = Number((ms >> 40n) & 0xffn)
  bytes[1] = Number((ms >> 32n) & 0xffn)
  bytes[2] = Number((ms >> 24n) & 0xffn)
  bytes[3] = Number((ms >> 16n) & 0xffn)
  bytes[4] = Number((ms >> 8n) & 0xffn)
  bytes[5] = Number(ms & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isUuidV7(value: string): boolean {
  return UUID_RE.test(value)
}

function brand<T extends string>(value: string, name: string): T {
  if (!isUuidV7(value)) throw new Error(`${name} must be a UUIDv7`)
  return value as T
}

export const DeviceId = (value: string): DeviceId => brand(value, 'DeviceId')
export const RoomId = (value: string): RoomId => brand(value, 'RoomId')
export const MatchId = (value: string): MatchId => brand(value, 'MatchId')
export const GrantId = (value: string): GrantId => brand(value, 'GrantId')
export const StakeId = (value: string): StakeId => brand(value, 'StakeId')
export const InferenceId = (value: string): InferenceId => brand(value, 'InferenceId')
export const MessageId = (value: string): MessageId => brand(value, 'MessageId')

export function newDeviceId(): DeviceId { return DeviceId(uuidv7()) }
export function newRoomId(): RoomId { return RoomId(uuidv7()) }
export function newMatchId(): MatchId { return MatchId(uuidv7()) }
export function newGrantId(): GrantId { return GrantId(uuidv7()) }
export function newStakeId(): StakeId { return StakeId(uuidv7()) }
export function newInferenceId(): InferenceId { return InferenceId(uuidv7()) }
export function newMessageId(): MessageId { return MessageId(uuidv7()) }

export function RoomCode(value: string): RoomCode {
  if (value.length !== 6 || !CROCKFORD_RE.test(value)) throw new Error('room code must be 6 Crockford characters')
  return value as RoomCode
}

export function InviteCode(value: string): InviteCode {
  if (value.length < 10 || value.length > 32 || !CROCKFORD_RE.test(value)) {
    throw new Error('invite code must be 10-32 Crockford characters')
  }
  return value as InviteCode
}

export function randomCrockford(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => CROCKFORD[b % CROCKFORD.length]).join('')
}

export function newRoomCode(): RoomCode {
  return RoomCode(randomCrockford(6))
}

export function newInviteCode(): InviteCode {
  return InviteCode(randomCrockford(16))
}
