import { DECISION_TIMEOUT_MS, MAX_OUTPUT_TOKENS, type AgentDecision } from '@agent-colosseum/protocol'
import type { LegalAction, PublicMatchSnapshot, Seat } from '@agent-colosseum/poker'
import { MATCH_SYSTEM_PROMPT } from './prompt.ts'
import { extractDecision } from './parse-decision.ts'

export interface AgentLike {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel?(cause?: unknown): void
  ctx: {
    tools?: {
      presentAs(mode: 'native'): () => void
      restrict(filter: { allow: string[] }): () => void
    }
    systemPrompt?: {
      section(section: { name: string; order: number; text: string; complete?: boolean }): () => void
      suppressRuntimeContext(): () => void
    }
  }
  session?: { events?: unknown[] }
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

export interface RunnerDeps {
  agents: AgentsLike
  now?: () => number
  waitForOutput: (agent: AgentLike, startedAt: number) => Promise<string>
  createSessionId?: () => string
}

export class ArenaAgentRunner {
  private readonly live = new Map<string, AgentHandleLike>()

  constructor(private readonly deps: RunnerDeps) {}

  async createContestant(input: {
    key: string
    provider: string
    model: string
    sessionId?: string
  }): Promise<AgentHandleLike> {
    await this.dispose(input.key)
    const handle = await this.deps.agents.create({
      sessionId: input.sessionId ?? this.deps.createSessionId?.() ?? `arena-${input.key}-${Date.now()}`,
      agentOptions: {
        provider: input.provider,
        model: input.model,
        maxTokens: MAX_OUTPUT_TOKENS,
      },
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
    seat: Seat
    hole: [string, string]
  }): Promise<{ decision: AgentDecision; fault?: 'agent_fault'; followedUpAt: number; idleAt: number }> {
    const handle = this.live.get(input.key)
    if (!handle) throw new Error(`no contestant ${input.key}`)
    const deadline = (this.deps.now?.() ?? Date.now()) + DECISION_TIMEOUT_MS
    const prompt = renderDecisionPrompt(input.snapshot, input.seat, input.hole)
    const followedUpAt = this.deps.now?.() ?? Date.now()
    handle.agent.followup({
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    })
    let text = ''
    try {
      text = await withTimeout(this.deps.waitForOutput(handle.agent, followedUpAt), remaining(deadline))
      const decision = extractDecision(text)
      assertLegal(decision, input.snapshot.legal)
      const idleAt = this.deps.now?.() ?? Date.now()
      return { decision, followedUpAt, idleAt }
    } catch {
      const repairAt = this.deps.now?.() ?? Date.now()
      handle.agent.followup({
        role: 'user',
        content: [{
          type: 'text',
          text: `Your previous output was invalid. Reply with one legal JSON object. Legal actions: ${JSON.stringify(input.snapshot.legal)}`,
        }],
      })
      try {
        text = await withTimeout(this.deps.waitForOutput(handle.agent, repairAt), remaining(deadline))
        const decision = extractDecision(text)
        assertLegal(decision, input.snapshot.legal)
        return { decision, followedUpAt, idleAt: this.deps.now?.() ?? Date.now() }
      } catch {
        const fallback = input.snapshot.legal.some((item) => item.action === 'check')
          ? { action: 'check' as const, publicRationale: 'agent_fault: check' }
          : { action: 'fold' as const, publicRationale: 'agent_fault: fold' }
        return {
          decision: fallback,
          fault: 'agent_fault',
          followedUpAt,
          idleAt: this.deps.now?.() ?? Date.now(),
        }
      }
    }
  }

  async dispose(key?: string): Promise<void> {
    const keys = key ? [key] : [...this.live.keys()]
    await Promise.all(keys.map(async (item) => {
      const handle = this.live.get(item)
      this.live.delete(item)
      if (handle) await handle.dispose()
    }))
  }
}

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('decision timeout')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
    if (match.maxRaiseTo !== undefined && raiseTo > match.maxRaiseTo) throw new Error('above max raise')
  }
}

export function renderDecisionPrompt(snapshot: PublicMatchSnapshot, seat: Seat, hole: [string, string]): string {
  return JSON.stringify({
    seat,
    hole,
    handNo: snapshot.handNo,
    street: snapshot.street,
    board: snapshot.board,
    stacks: snapshot.stacks,
    pot: snapshot.pot,
    currentBet: snapshot.currentBet,
    streetCommitted: snapshot.streetCommitted,
    legal: snapshot.legal,
    blinds: snapshot.blinds,
  })
}
