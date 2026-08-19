export type { PokerMatchStateV1, SeatId, PokerActionKind, AgentDecision } from '@agent-colosseum/protocol'
import type { PokerActionKind, SeatId } from '@agent-colosseum/protocol'

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete'

export interface LegalAction {
  action: PokerActionKind
  raiseTo?: number
  minRaiseTo?: number
  maxRaiseTo?: number
}

export interface PublicMatchSnapshot {
  matchId: string
  handNo: number
  actionSeq: number
  street: Street
  button: SeatId
  seats: Record<SeatId, { deviceId: string; stack: number; streetCommitted: number }>
  pot: number
  currentBet: number
  toAct: SeatId | null
  legal: LegalAction[]
  board: string[]
  holes: Partial<Record<SeatId, [string, string]>>
  blinds: { small: number; big: number }
  lastActions: Array<{
    seat: SeatId
    action: PokerActionKind
    raiseTo?: number
    publicRationale: string
    fault?: 'agent_fault' | 'timeout' | 'illegal'
  }>
  terminal: {
    reason: string
    winnerDeviceId: string | null
    stacks: Record<string, number>
    grantTransferred: boolean
  } | null
}
