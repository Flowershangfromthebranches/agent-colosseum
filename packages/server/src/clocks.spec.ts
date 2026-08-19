import { describe, expect, it } from 'vitest'
import { ArenaClocks } from './clocks.ts'

describe('ArenaClocks', () => {
  it('fires action and disconnect handlers once, then cancels leftovers', async () => {
    const actions: Array<{ matchId: string; seq: number }> = []
    const disconnects: string[] = []
    const clocks = new ArenaClocks({
      onActionTimeout(matchId, actionSeq) { actions.push({ matchId, seq: actionSeq }) },
      onDisconnectCheck(matchId) { disconnects.push(matchId) },
    })
    clocks.scheduleAction('m1', 3, 5)
    clocks.scheduleAction('m1', 4, 5)
    clocks.scheduleDisconnect('m1', 5)
    clocks.scheduleDisconnect('m2', 30_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(actions).toEqual([{ matchId: 'm1', seq: 4 }])
    expect(disconnects).toEqual(['m1'])
    expect(clocks.size).toBe(1)
    clocks.cancelAction('m2')
    clocks.cancelMatch('m2')
    clocks.scheduleAction('m3', 1, 30_000)
    clocks.dispose()
    expect(clocks.size).toBe(0)
  })
})
