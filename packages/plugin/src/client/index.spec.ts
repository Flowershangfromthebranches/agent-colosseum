import { describe, expect, it } from 'vitest'
import { apply, name } from './index.ts'

describe('client apply', () => {
  it('injects footer and overlay slots', () => {
    const injected: string[] = []
    const registered: string[] = []
    const ctx = {
      slots: {
        inject(key: string, callback: () => () => void) {
          injected.push(key)
          const off = callback()
          return off
        },
        register(options: { name: string }, _component: unknown) {
          registered.push(options.name)
          return () => undefined
        },
      },
      connection: { rpc: { async call() { return { ok: true } } } },
      effect(fn: () => () => void) {
        const dispose = fn()
        dispose()
      },
    }
    apply(ctx as never)
    expect(name).toBe('agent-colosseum-client')
    expect(injected).toEqual(['sidebar.footer.action', 'shell.overlay'])
    expect(registered).toEqual(['sidebar.footer.action', 'shell.overlay'])
  })
})
