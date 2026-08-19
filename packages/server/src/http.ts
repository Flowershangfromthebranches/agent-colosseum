import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { parseClientFrame, PROTOCOL_VERSION } from '@agent-colosseum/protocol'
import { ArenaService, serverFrame } from './arena.ts'
import type { ServerConfig } from './config.ts'
import { logJson } from './log.ts'
import type { ArenaStore } from './store.ts'

export async function buildServer(arena: ArenaService, config: ServerConfig, extras?: {
  redisPing?: () => Promise<boolean>
}) {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  app.get('/healthz', async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION, region: 'single' }))

  app.get('/readyz', async (_, reply) => {
    const db = await arena.store.ping()
    const redis = extras?.redisPing ? await extras.redisPing() : true
    if (!db || !redis) return reply.code(503).send({ ok: false, db, redis })
    return { ok: true, db, redis }
  })

  app.get('/metrics', async () => [
    '# TYPE arena_up gauge',
    'arena_up 1',
  ].join('\n'))

  app.get('/v1/ws', { websocket: true }, (socket) => {
    let deviceId: string | null = null
    let detach: (() => void) | undefined
    const queue: string[] = []
    const MAX = 32
    const sendRaw = (value: unknown) => {
      const text = JSON.stringify(value)
      if (queue.length >= MAX) {
        socket.close(4002, 'slow consumer')
        return
      }
      queue.push(text)
      while (queue.length > 0 && socket.readyState === socket.OPEN) socket.send(queue.shift()!)
    }

    socket.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const parsed = parseClientFrame(JSON.parse(String(raw)))
        if (parsed.type === 'auth.hello') {
          const challenge = arena.issueChallenge(
            parsed.payload.ed25519PublicKey,
            parsed.payload.x25519PublicKey,
            parsed.payload.inviteCode,
          )
          sendRaw(serverFrame('auth.challenge', challenge))
          return
        }
        if (parsed.type === 'auth.challenge_response') {
          const device = await arena.redeem({
            nonce: parsed.payload.nonce,
            signature: parsed.payload.signature,
            ...parsed.payload.deviceId ? { deviceId: parsed.payload.deviceId } : {},
          })
          deviceId = device.deviceId
          detach = arena.attach(deviceId, (frame) => sendRaw(serverFrame(frame.type, frame.payload)))
          sendRaw(serverFrame('auth.session', { deviceId, sessionToken: device.deviceId }))
          return
        }
        if (!deviceId) throw new Error('unauthenticated')
        if (parsed.type === 'auth.hello') throw new Error('already authenticated')
        await arena.handle(deviceId, parsed)
      } catch (error) {
        logJson('warn', 'ws.error', { message: error instanceof Error ? error.message : 'error' })
        sendRaw(serverFrame('error', { message: error instanceof Error ? error.message : String(error) }))
      }
    })

    socket.on('close', () => { detach?.() })
    void config
  })

  return app
}

export async function pingStore(store: ArenaStore): Promise<boolean> {
  return store.ping()
}
