import { z } from 'zod'
import { MAX_RATIONALE_CHARS, SUPPORTED_ACTIONS } from './constants.ts'

export const pokerActionSchema = z.object({
  matchId: z.string().uuid(),
  handNo: z.number().int().positive(),
  actionSeq: z.number().int().nonnegative(),
  action: z.enum(SUPPORTED_ACTIONS),
  raiseTo: z.number().int().positive().optional(),
  publicRationale: z.string().max(MAX_RATIONALE_CHARS),
}).superRefine((value, ctx) => {
  if (value.action === 'raise' && value.raiseTo === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'raise requires raiseTo (street-total chips)',
      path: ['raiseTo'],
    })
  }
  if (value.action !== 'raise' && value.raiseTo !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'raiseTo is only valid for raise',
      path: ['raiseTo'],
    })
  }
})

export type PokerAction = z.infer<typeof pokerActionSchema>

export const agentDecisionSchema = z.object({
  action: z.enum(SUPPORTED_ACTIONS),
  raiseTo: z.number().int().positive().optional(),
  publicRationale: z.string().max(MAX_RATIONALE_CHARS),
}).superRefine((value, ctx) => {
  if (value.action === 'raise' && value.raiseTo === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'raise requires raiseTo',
      path: ['raiseTo'],
    })
  }
})

export type AgentDecision = z.infer<typeof agentDecisionSchema>
