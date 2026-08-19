import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { PROTOCOL_VERSION, parseArenaFrame, ProtocolError } from '@agent-colosseum/protocol'
import type { ArenaService } from './arena.ts'
import type { ServerConfig } from './config.ts'

export async function buildServer(arena: ArenaService, config: ServerConfig) {
  const app = Fastify({ logger: false })
  await app.register(websocket)

  app.get('/healthz', async () => ({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    region: 'single',
  }))

  app.get('/readyz', async (_, reply) => {
    return reply.send({ ok: true, db: 'ok', redis: 'ok' })
  })

  app.get('/v1/ws', { websocket: true }, (socket, request) => {
    let deviceId: string | null = null
    let lastSeq = 0
    const outbound: string[] = []
    const MAX_QUEUE = 32

    const send = (value: unknown) => {
      const text = JSON.stringify(value)
      if (socket.readyState !== socket.OPEN) return
      if (outbound.length >= MAX_QUEUE) {
        socket.close(4002, 'slow consumer')
        return
      }
      outbound.push(text)
      flush()
    }
    const flush = () => {
      while (outbound.length > 0 && socket.readyState === socket.OPEN) {
        socket.send(outbound.shift()!)
      }
    }

    socket.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const frame = parseArenaFrame(JSON.parse(String(raw)))
        if (frame.type === 'auth.hello') {
          const challenge = arena.issueChallenge(frame.payload.ed25519PublicKey, frame.payload.x25519PublicKey)
          send({
            protocolVersion: PROTOCOL_VERSION,
            messageId: frame.messageId,
            deviceId: frame.deviceId,
            type: 'auth.challenge',
            payload: challenge,
          })
          return
        }
        if (frame.type === 'auth.challenge_response') {
          const inviteHeader = request.headers['x-invite-code']
          const device = await arena.redeemChallenge({
            nonce: frame.payload.nonce,
            signature: frame.payload.signature,
            ...inviteHeader === undefined ? {} : { inviteCode: String(inviteHeader) },
            deviceId: frame.deviceId,
          })
          deviceId = device.deviceId
          arena.presence.connect(deviceId)
          send({
            protocolVersion: PROTOCOL_VERSION,
            messageId: frame.messageId,
            deviceId: device.deviceId,
            type: 'auth.session',
            payload: { sessionToken: device.deviceId, deviceId: device.deviceId },
          })
          return
        }
        if (!deviceId) throw new Error('unauthenticated')
        if (frame.deviceId !== deviceId) throw new ProtocolError('DEVICE_MISMATCH', 'deviceId mismatch')
        arena.presence.beat(deviceId)
        if (frame.type === 'session.heartbeat') return
        if (frame.type === 'room.create') {
          const room = await arena.createRoom(deviceId, frame.payload.stake)
          send({ type: 'room.created', payload: room })
          return
        }
        if (frame.type === 'room.join') {
          const room = await arena.joinRoom(deviceId, frame.payload.roomCode, frame.payload.stake)
          send({ type: 'room.updated', payload: room })
          return
        }
        if (frame.type === 'room.accept') {
          const room = await arena.acceptRoom(deviceId, frame.payload.roomId)
          send({ type: 'room.updated', payload: room })
          return
        }
        if (frame.type === 'room.leave') {
          await arena.leaveRoom(deviceId, frame.payload.roomId)
          return
        }
        if (frame.type === 'match.action') {
          const engine = await arena.submitAction(deviceId, frame.payload)
          send({ type: 'match.snapshot', payload: engine.snapshot(engine.seatOf(deviceId)) })
          return
        }
        if (frame.type === 'relay.reserve') {
          const result = await arena.relay.reserve({
            grantId: frame.payload.grantId,
            inferenceId: frame.payload.inferenceId,
            winnerDeviceId: deviceId,
            requestBytes: frame.payload.requestBytes,
            estimatedInputTokens: frame.payload.estimatedInputTokens,
            ownerOnline: arena.presence.isOnline((await arena.store.getGrant(frame.payload.grantId))!.ownerDeviceId),
          })
          send({ type: 'relay.reserved', payload: { created: result.created, grant: result.grant } })
          return
        }
        if (frame.type === 'relay.inference_started') {
          const grant = await arena.relay.inferenceStarted(frame.payload.grantId, frame.payload.inferenceId)
          send({ type: 'grant.updated', payload: grant })
          return
        }
        if (frame.type === 'relay.terminal') {
          await arena.relay.terminal(frame.payload.grantId, frame.payload.inferenceId, frame.payload.status === 'owner_offline' ? 'aborted' : frame.payload.status)
          return
        }
        throw new ProtocolError('UNHANDLED', `unhandled ${frame.type}`)
      } catch (error) {
        send({
          type: 'error',
          payload: { message: error instanceof Error ? error.message : String(error) },
        })
      }
    })

    socket.on('close', () => {
      if (deviceId) void arena.handleDisconnect(deviceId)
    })
    void lastSeq
    void config
  })

  return app
}
