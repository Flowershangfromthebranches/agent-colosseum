import type { AgentDecision } from '@agent-colosseum/protocol'
import type { LegalAction } from './types.ts'

export type ScriptKind = 'check-fold' | 'call-station' | 'min-raise-once'

export function scriptDecide(kind: ScriptKind, legal: LegalAction[], handNo: number): AgentDecision {
  if (kind === 'check-fold') {
    if (legal.some((item) => item.action === 'check')) return { action: 'check', publicRationale: 'script: check' }
    return { action: 'fold', publicRationale: 'script: fold' }
  }
  if (kind === 'call-station') {
    if (legal.some((item) => item.action === 'check')) return { action: 'check', publicRationale: 'script: check' }
    if (legal.some((item) => item.action === 'call')) return { action: 'call', publicRationale: 'script: call' }
    return { action: 'fold', publicRationale: 'script: fold' }
  }
  if (handNo === 1 && legal.some((item) => item.action === 'raise')) {
    const raise = legal.find((item) => item.action === 'raise')!
    return { action: 'raise', raiseTo: raise.minRaiseTo, publicRationale: 'script: min-raise' }
  }
  if (legal.some((item) => item.action === 'check')) return { action: 'check', publicRationale: 'script: check' }
  if (legal.some((item) => item.action === 'call')) return { action: 'call', publicRationale: 'script: call' }
  return { action: 'fold', publicRationale: 'script: fold' }
}
