export const PROTOCOL_VERSION = 1 as const
export const PINNED_DSH_VERSION = '0.1.0-rc.7'
export const PROVIDER_ID = 'agent-colosseum'
export const RPC_CHANNEL = '/agent-colosseum'

export const STARTING_STACK = 80
export const MAX_HANDS = 20
export const DECISION_TIMEOUT_MS = 60_000
export const MAX_OUTPUT_TOKENS = 256
export const MAX_RATIONALE_CHARS = 280
export const DISCONNECT_FORFEIT_MS = 90_000
export const HEARTBEAT_INTERVAL_MS = 15_000
export const HEARTBEAT_TIMEOUT_MS = 45_000
export const GRANT_ONLINE_TTL_SECONDS = 604_800
export const MAX_REQUEST_BYTES = 65_536
export const DEFAULT_MAX_CALLS = 10
export const DEFAULT_MAX_ESTIMATED_INPUT_TOKENS = 16_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
export const DEFAULT_MAX_CONCURRENCY = 1

export const BLIND_SCHEDULE = [
  { fromHand: 1, small: 1, big: 2 },
  { fromHand: 6, small: 2, big: 4 },
  { fromHand: 11, small: 4, big: 8 },
  { fromHand: 16, small: 8, big: 16 },
] as const

export const SUPPORTED_ACTIONS = ['fold', 'check', 'call', 'raise'] as const
export type PokerActionKind = (typeof SUPPORTED_ACTIONS)[number]

export const GRANT_STATUSES = ['active', 'exhausted', 'suspended', 'defaulted'] as const
export type GrantStatus = (typeof GRANT_STATUSES)[number]

export const MATCH_TERMINAL_REASONS = [
  'bust',
  'chip_lead',
  'forfeit',
  'double_disconnect',
  'server_fault',
  'draw_released',
] as const
export type MatchTerminalReason = (typeof MATCH_TERMINAL_REASONS)[number]
