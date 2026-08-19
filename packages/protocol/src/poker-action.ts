import { z } from 'zod'
import { MAX_RATIONALE_CHARS, SCHEMA_VERSION, STARTING_STACK, SUPPORTED_ACTIONS } from './constants.ts'

export const pokerActionSchema = z.object({
  matchId: z.string().uuid(),
  handNo: z.number().int().positive(),
  actionSeq: z.number().int().nonnegative(),
  action: z.enum(SUPPORTED_ACTIONS),
  raiseTo: z.number().int().positive().optional(),
  publicRationale: z.string().max(MAX_RATIONALE_CHARS),
}).superRefine((value, ctx) => {
  if (value.action === 'raise' && value.raiseTo === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'raise requires raiseTo', path: ['raiseTo'] })
  }
  if (value.action !== 'raise' && value.raiseTo !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'raiseTo is only valid for raise', path: ['raiseTo'] })
  }
})

export type PokerActionV1 = z.infer<typeof pokerActionSchema>
export type PokerAction = PokerActionV1

export const agentDecisionSchema = z.object({
  action: z.enum(SUPPORTED_ACTIONS),
  raiseTo: z.number().int().positive().optional(),
  publicRationale: z.string().max(MAX_RATIONALE_CHARS),
}).superRefine((value, ctx) => {
  if (value.action === 'raise' && value.raiseTo === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'raise requires raiseTo', path: ['raiseTo'] })
  }
})

export type AgentDecision = z.infer<typeof agentDecisionSchema>

export const seatSchema = z.enum(['A', 'B'])
export type SeatId = z.infer<typeof seatSchema>
export const streetSchema = z.enum(['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'])

export const pokerMatchStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  matchId: z.string().uuid(),
  players: z.object({
    A: z.object({ deviceId: z.string().uuid(), stack: z.number().int().nonnegative() }),
    B: z.object({ deviceId: z.string().uuid(), stack: z.number().int().nonnegative() }),
  }),
  button: seatSchema,
  handNo: z.number().int().nonnegative(),
  street: streetSchema,
  actionSeq: z.number().int().nonnegative(),
  deck: z.array(z.string().min(2).max(3)).length(52),
  deckCursor: z.number().int().nonnegative(),
  holes: z.object({
    A: z.tuple([z.string(), z.string()]).nullable(),
    B: z.tuple([z.string(), z.string()]).nullable(),
  }),
  board: z.array(z.string()),
  streetCommitted: z.object({ A: z.number().int().nonnegative(), B: z.number().int().nonnegative() }),
  handCommitted: z.object({ A: z.number().int().nonnegative(), B: z.number().int().nonnegative() }),
  folded: z.object({ A: z.boolean(), B: z.boolean() }),
  allIn: z.object({ A: z.boolean(), B: z.boolean() }),
  currentBet: z.number().int().nonnegative(),
  lastRaiseSize: z.number().int().nonnegative(),
  toAct: seatSchema.nullable(),
  pot: z.number().int().nonnegative(),
  actedThisStreet: z.array(seatSchema),
  lastActions: z.array(z.object({
    seat: seatSchema,
    action: z.enum(SUPPORTED_ACTIONS),
    raiseTo: z.number().int().positive().optional(),
    publicRationale: z.string(),
    fault: z.enum(['agent_fault', 'timeout', 'illegal']).optional(),
  })),
  terminal: z.object({
    reason: z.string(),
    winnerDeviceId: z.string().uuid().nullable(),
    stacks: z.record(z.number()),
    grantTransferred: z.boolean(),
  }).nullable(),
  startingStack: z.literal(STARTING_STACK),
})

export type PokerMatchStateV1 = z.infer<typeof pokerMatchStateSchema>
