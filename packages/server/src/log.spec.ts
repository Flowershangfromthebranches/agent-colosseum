import { describe, expect, it, vi } from 'vitest'
import { logJson } from './log.ts'

describe('log redaction', () => {
  it('redacts secrets and writes json lines', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logJson('info', 'ok', { apiKey: 'sk-secret', path: '/x' })
    logJson('warn', 'slow', { message: 'invite leaked' })
    logJson('error', 'boom', { requestId: 'r1' })
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/redacted/)
    expect(err).toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    spy.mockRestore()
    err.mockRestore()
    warn.mockRestore()
  })
})
