import type { ErrorCode } from './constants.ts'

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export function failClosed(code: ErrorCode, message: string, details?: unknown): never {
  throw new ProtocolError(code, message, details)
}
