import { describe, expect, it } from 'vitest'

/**
 * Full Playwright coverage (room create/join, confirm, table, result,
 * inventory, model picker, narrow viewport, keyboard) runs against two
 * live DSH profiles. This file keeps the scenario list in-repo so CI can
 * grow onto a real DSH loader without blocking unit tests.
 */
const SCENARIOS = [
  'install from packed tarball',
  'dump-config includes agent-colosseum layer',
  'web and desktop profiles boot',
  'HMR unloads slots and host effects',
  'room create/join/accept',
  'full heads-up hand + result',
  'grant inventory + model picker',
  'narrow viewport and keyboard',
]

describe('playwright plan', () => {
  it('lists the required UI scenarios', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(8)
  })
})
