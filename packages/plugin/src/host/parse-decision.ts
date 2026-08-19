import { agentDecisionSchema, type AgentDecision } from '@agent-colosseum/protocol'

export function extractDecision(text: string): AgentDecision {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in model output')
  return agentDecisionSchema.parse(JSON.parse(trimmed.slice(start, end + 1)))
}

export function textFromAssistantMessage(message: { content?: Array<{ type?: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
