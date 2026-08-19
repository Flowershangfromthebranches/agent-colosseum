import { DECISION_TIMEOUT_MS, MAX_OUTPUT_TOKENS, type AgentDecision } from '@agent-colosseum/protocol'
import type { LegalAction, PublicMatchSnapshot, SeatId } from '@agent-colosseum/poker'
import { MATCH_SYSTEM_PROMPT } from './prompt.ts'
import { extractDecision, textFromAssistantMessage } from './parse-decision.ts'

export interface SessionLike {
  events: Array<{ type?: string; seq?: number; data?: { message?: { content?: Array<{ type?: string; text?: string }> } } }>
}

export interface AgentLike {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel?(cause?: unknown): void
  session?: SessionLike
  ctx: {
    tools?: { presentAs(mode: 'native'): () => void; restrict(filter: { allow: string[] }): () => void }
    systemPrompt?: {
      section(section: { name: string; order: number; text: string; complete?: boolean }): () => void
      suppressRuntimeContext(): () => void
    }
  }
}

export interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

export interface AgentsLike {
  create(options: {
    sessionId: string
    agentOptions?: { provider: string; model: string; maxTokens: number }
    setup?: (agentCtx: AgentLike['ctx']) => void | Promise<void>
  }): Promise<AgentHandleLike>
}

export class ArenaAgentRunner {
  private readonly live = new Map<string, AgentHandleLike>()
  private tail = Promise.resolve()

  constructor(
    private readonly agents: AgentsLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async createContestant(input: { key: string; provider: string; model: string; sessionId?: string }): Promise<AgentHandleLike> {
    await this.dispose(input.key)
    const handle = await this.agents.create({
      sessionId: input.sessionId ?? `arena-${input.key}-${this.now()}`,
      agentOptions: { provider: input.provider, model: input.model, maxTokens: MAX_OUTPUT_TOKENS },
      setup: (agentCtx) => {
        agentCtx.systemPrompt?.suppressRuntimeContext()
        agentCtx.systemPrompt?.section({
          name: 'agent-colosseum:complete',
          order: 0,
          complete: true,
          text: MATCH_SYSTEM_PROMPT,
        })
        agentCtx.tools?.presentAs('native')
        agentCtx.tools?.restrict({ allow: [] })
      },
    })
    this.live.set(input.key, handle)
    return handle
  }

  async decide(input: {
    key: string
    snapshot: PublicMatchSnapshot
    seat: SeatId
    hole: [string, string]
  }): Promise<{ decision: AgentDecision; fault?: 'agent_fault'; followedUpAt: number; idleAt: number }> {
    const handle = this.live.get(input.key)
    if (!handle) throw new Error(`no contestant ${input.key}`)
    return this.serialize(async () => {
      const deadline = this.now() + DECISION_TIMEOUT_MS
      const prompt = JSON.stringify({
        seat: input.seat,
        hole: input.hole,
        handNo: input.snapshot.handNo,
        street: input.snapshot.street,
        board: input.snapshot.board,
        stacks: Object.fromEntries(Object.entries(input.snapshot.seats).map(([k, v]) => [k, v.stack])),
        pot: input.snapshot.pot,
        currentBet: input.snapshot.currentBet,
        legal: input.snapshot.legal,
        blinds: input.snapshot.blinds,
      })
      const first = await this.turn(handle, prompt, deadline, input.snapshot.legal)
      if (first.ok) return first.value
      const repair = `Your previous output was invalid. Reply with one legal JSON object. Legal: ${JSON.stringify(input.snapshot.legal)}`
      const second = await this.turn(handle, repair, deadline, input.snapshot.legal)
      if (second.ok) return second.value
      const fallback = input.snapshot.legal.some((item) => item.action === 'check')
        ? { action: 'check' as const, publicRationale: 'agent_fault: check' }
        : { action: 'fold' as const, publicRationale: 'agent_fault: fold' }
      return { decision: fallback, fault: 'agent_fault' as const, followedUpAt: first.followedUpAt, idleAt: this.now() }
    })
  }

  async dispose(key?: string): Promise<void> {
    const keys = key ? [key] : [...this.live.keys()]
    await Promise.all(keys.map(async (item) => {
      const handle = this.live.get(item)
      this.live.delete(item)
      if (!handle) return
      handle.agent.cancel?.('arena-dispose')
      await handle.agent.whenIdle()
      await handle.dispose()
    }))
  }

  private async turn(handle: AgentHandleLike, text: string, deadline: number, legal: LegalAction[]): Promise<
    | { ok: true; value: { decision: AgentDecision; followedUpAt: number; idleAt: number } }
    | { ok: false; followedUpAt: number }
  > {
    const seq = lastSeq(handle.agent.session)
    const followedUpAt = this.now()
    handle.agent.followup({
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    try {
      await withTimeout(handle.agent.whenIdle(), Math.max(0, deadline - this.now()))
      const idleAt = this.now()
      const output = collectText(handle.agent.session, seq)
      const decision = extractDecision(output)
      assertLegal(decision, legal)
      return { ok: true, value: { decision, followedUpAt, idleAt } }
    } catch {
      return { ok: false, followedUpAt }
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function lastSeq(session?: SessionLike): number {
  const last = session?.events.at(-1)
  return typeof last?.seq === 'number' ? last.seq : -1
}

function collectText(session: SessionLike | undefined, afterSeq: number): string {
  if (!session) return ''
  return session.events
    .filter((event) => (event.seq ?? -1) > afterSeq && event.type === 'assistant/message')
    .map((event) => textFromAssistantMessage(event.data?.message ?? {}))
    .join('')
}

function assertLegal(decision: AgentDecision, legal: LegalAction[]): void {
  const match = legal.find((item) => item.action === decision.action)
  if (!match) throw new Error('illegal action')
  if (decision.action === 'raise') {
    const raiseTo = decision.raiseTo
    if (raiseTo === undefined) throw new Error('missing raiseTo')
    if (match.minRaiseTo !== undefined && raiseTo < match.minRaiseTo && raiseTo !== match.maxRaiseTo) {
      throw new Error('below min raise')
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
