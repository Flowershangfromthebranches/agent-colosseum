import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_OPENAI_PORT ?? 8899)

function sseChunk(delta) {
  return `data: ${JSON.stringify({
    id: 'mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`
}

const server = createServer(async (req, res) => {
  const url = req.url ?? ''
  if (req.method === 'GET' && url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'fold-a', object: 'model' },
        { id: 'fold-b', object: 'model' },
      ],
    }))
    return
  }
  if (req.method !== 'POST' || !url.includes('/chat/completions')) {
    res.writeHead(404)
    res.end()
    return
  }
  const chunks = []
  for await (const part of req) chunks.push(part)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const text = JSON.stringify(body)
  const poker = /legal|publicRationale|"action"|preflop|handNo/.test(text)
  const content = poker
    ? '{"action":"fold","publicRationale":"script-fold"}'
    : 'reward-ok'
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  res.write(sseChunk({ role: 'assistant' }))
  res.write(sseChunk({ content }))
  res.write(`data: ${JSON.stringify({
    id: 'mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`mock-openai listening on 127.0.0.1:${PORT}\n`)
})
