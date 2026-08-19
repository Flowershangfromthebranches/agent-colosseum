/**
 * UserMessage factory compatible with DeepSeek Harness 0.1.0-rc.7
 * `createUserMessage()` (`role: 'user'`, frozen content, stable id).
 * Contest Agents only receive this shape — never raw strings.
 */
export function createUserMessage(input: {
  content: Array<{ type: 'text'; text: string }>
  source?: { kind: string }
}): {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: string }
} {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: input.content.map((block) => ({ type: 'text' as const, text: block.text })),
    source: input.source ?? { kind: 'user' },
  }
}
