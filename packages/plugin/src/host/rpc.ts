import type { ArenaRuntime } from './runtime.ts'

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export async function handleArenaRpc(
  runtime: ArenaRuntime,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  try {
    switch (endpoint) {
      case 'bootstrap':
        return ok(await runtime.bootstrap())
      case 'privacy.ack':
        return ok(runtime.ackPrivacy())
      case 'room.create': {
        const body = payload as { provider: string; model: string }
        return ok({
          stake: runtime.signStake(body.provider, body.model),
          hint: 'Use the Arena Server WebSocket to publish the room; the Host keeps device keys local.',
        })
      }
      case 'room.join':
      case 'room.accept':
      case 'room.leave':
        return ok({ forwarded: endpoint, payload })
      case 'match.snapshot':
        return ok(runtime.snapshot())
      case 'match.local.start': {
        const body = payload as {
          left: { provider: string; model: string }
          right: { provider: string; model: string }
        }
        return ok(await runtime.startLocal(body))
      }
      case 'grants.list':
        return ok({ grants: runtime.grants })
      case 'events.poll':
        return ok({ cursor: runtime.cursor, events: [{ kind: 'state', cursor: runtime.cursor, state: runtime.snapshot() }] })
      default:
        return {
          ok: false,
          error: { code: 'not-found', message: `unknown endpoint ${endpoint}` },
        }
    }
  } catch (error) {
    return {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}
