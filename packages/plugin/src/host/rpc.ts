import { rpcEndpoints, type RpcEndpoint } from '@agent-colosseum/protocol'
import type { ArenaRuntime } from './runtime.ts'

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export async function handleArenaRpc(runtime: ArenaRuntime, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> {
  try {
    if (!rpcEndpoints.includes(endpoint as RpcEndpoint)) {
      return { ok: false, error: { code: 'not-found', message: `unknown endpoint ${endpoint}` } }
    }
    switch (endpoint as RpcEndpoint) {
      case 'bootstrap':
        return ok(await runtime.bootstrap())
      case 'privacy.ack':
        return ok(runtime.ackPrivacy())
      case 'models.list':
        return ok({ models: runtime.store.snapshot.models })
      case 'match.local.start': {
        const body = payload as { left: { provider: string; model: string }; right: { provider: string; model: string } }
        return ok(await runtime.startLocal(body.left, body.right))
      }
      case 'match.local.cancel':
        return ok(await runtime.cancelLocal())
      case 'room.create': {
        const body = payload as { provider: string; model: string }
        return ok(await runtime.createRoom(body.provider, body.model))
      }
      case 'room.join': {
        const body = payload as { roomCode: string; provider: string; model: string }
        return ok(await runtime.joinRoom(body.roomCode, body.provider, body.model))
      }
      case 'room.accept':
        return ok(runtime.acceptRoom())
      case 'room.leave':
        return ok(runtime.leaveRoom())
      case 'match.snapshot':
        return ok(runtime.store.snapshot)
      case 'grants.list':
        return ok({ grants: runtime.store.snapshot.grants })
      case 'grants.stream': {
        const body = payload as { grantId?: string; prompt?: string }
        return ok(await runtime.redeemGrant(String(body.grantId ?? ''), body.prompt ?? 'hello from winner'))
      }
      case 'events.poll': {
        const body = payload as { cursor?: number; timeoutMs?: number }
        if ((body.cursor ?? 0) >= runtime.store.version) await runtime.store.wait(body.timeoutMs ?? 15_000)
        return ok({
          cursor: runtime.store.version,
          events: [{ kind: 'state', cursor: runtime.store.version, state: runtime.store.snapshot }],
        })
      }
    }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
  }
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
