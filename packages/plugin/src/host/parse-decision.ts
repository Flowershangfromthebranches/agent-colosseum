import { agentDecisionSchema, type AgentDecision } from '@agent-colosseum/protocol'

export function extractDecision(text: string): AgentDecision {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in model output')
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown
  return agentDecisionSchema.parse(parsed)
}
