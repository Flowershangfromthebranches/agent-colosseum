import { describe, expect, it } from 'vitest'
import { ArenaApp } from '../src/client/overlay.tsx'

describe('overlay', () => {
  it('exports a launcher and overlay component', () => {
    expect(typeof ArenaApp).toBe('function')
  })
})
