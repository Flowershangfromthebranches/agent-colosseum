import type { PokerActionKind } from '@agent-colosseum/protocol'

export type Seat = 'button' | 'bb'
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete'

export interface PlayerState {
  seat: Seat
  deviceId: string
  stack: number
  streetCommitted: number
  handCommitted: number
  folded: boolean
  allIn: boolean
}

export interface LegalAction {
  action: PokerActionKind
  raiseTo?: number
  minRaiseTo?: number
  maxRaiseTo?: number
}

export interface AppliedAction {
  seat: Seat
  action: PokerActionKind
  raiseTo?: number
  publicRationale: string
  fault?: 'agent_fault' | 'timeout' | 'illegal'
}

export interface HandResult {
  winners: Seat[]
  pot: number
  oddChipTo: Seat | null
  returnedUncalled: { seat: Seat; amount: number } | null
  shown: Partial<Record<Seat, [string, string]>>
}

export interface MatchConfig {
  matchId: string
  buttonDeviceId: string
  bbDeviceId: string
  startingStack?: number
}

export interface PublicMatchSnapshot {
  matchId: string
  handNo: number
  actionSeq: number
  street: Street
  buttonDeviceId: string
  bbDeviceId: string
  stacks: Record<Seat, number>
  streetCommitted: Record<Seat, number>
  pot: number
  currentBet: number
  toAct: Seat | null
  legal: LegalAction[]
  board: string[]
  holes: Partial<Record<Seat, [string, string]>>
  blinds: { small: number; big: number }
  lastActions: AppliedAction[]
  terminal: MatchTerminal | null
}

export interface MatchTerminal {
  reason: 'bust' | 'chip_lead' | 'forfeit' | 'double_disconnect' | 'server_fault' | 'draw_released'
  winnerDeviceId: string | null
  stacks: Record<string, number>
  grantTransferred: boolean
}

export interface PrivateView {
  seat: Seat
  hole: [string, string] | null
}
