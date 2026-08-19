const REDACT = /api[_-]?key|authorization|password|secret|private|invite|cipher|prompt|sk-/i

export function logJson(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = { ts: new Date().toISOString(), level, event }
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT.test(key) || (typeof value === 'string' && REDACT.test(value))) {
      safe[key] = '[redacted]'
    } else {
      safe[key] = value
    }
  }
  const line = JSON.stringify(safe)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
