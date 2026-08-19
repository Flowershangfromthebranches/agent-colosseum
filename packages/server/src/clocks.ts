const ACTION_DEADLINE_MS = 60_000

export type ClockHandlers = {
  onActionTimeout(matchId: string, actionSeq: number): void
  onDisconnectCheck(matchId: string): void
}

export interface ClockBoard {
  scheduleAction(matchId: string, actionSeq: number, delayMs?: number): void
  scheduleDisconnect(matchId: string, delayMs: number): void
  cancelAction(matchId: string): void
  cancelMatch(matchId: string): void
  dispose(): void
  readonly size: number
}

export class ArenaClocks implements ClockBoard {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly handlers: ClockHandlers) {}

  scheduleAction(matchId: string, actionSeq: number, delayMs = ACTION_DEADLINE_MS): void {
    this.set(`act:${matchId}`, delayMs, () => this.handlers.onActionTimeout(matchId, actionSeq))
  }

  scheduleDisconnect(matchId: string, delayMs: number): void {
    this.set(`disc:${matchId}`, delayMs, () => this.handlers.onDisconnectCheck(matchId))
  }

  cancelAction(matchId: string): void {
    this.clear(`act:${matchId}`)
  }

  cancelMatch(matchId: string): void {
    this.clear(`act:${matchId}`)
    this.clear(`disc:${matchId}`)
  }

  dispose(): void {
    for (const key of Array.from(this.timers.keys())) this.clear(key)
  }

  get size(): number {
    return this.timers.size
  }

  private set(key: string, delayMs: number, fn: () => void): void {
    this.clear(key)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      fn()
    }, Math.max(0, delayMs))
    timer.unref()
    this.timers.set(key, timer)
  }

  private clear(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
  }
}
