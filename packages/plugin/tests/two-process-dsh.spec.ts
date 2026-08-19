import { fork, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDshHost, type DshHost } from './dsh-player.ts'
import type { GrantV1 } from '@agent-colosseum/protocol'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const pluginRoot = join(here, '..')
const tsxLoader = join(repoRoot, 'packages/server/node_modules/tsx/dist/loader.mjs')
const playerFile = join(here, 'dsh-player.ts')
const DEFAULT_WS = process.env.ARENA_WS_URL ?? 'ws://127.0.0.1:8787/v1/ws'

async function liveArenaUrl(): Promise<string | null> {
  const http = DEFAULT_WS.replace(/^ws/, 'http').replace(/\/v1\/ws$/, '')
  try {
    const response = await fetch(`${http}/readyz`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return null
    const body = await response.json() as { ok?: boolean; db?: boolean; redis?: boolean }
    return body.ok && body.db && body.redis ? DEFAULT_WS : null
  } catch {
    return null
  }
}

class PlayerProc {
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()

  constructor(private readonly child: ChildProcess) {
    child.on('message', (msg: { id?: number; result?: unknown; error?: string; op?: string }) => {
      if (msg.id === undefined) return
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error))
      else waiter.resolve(msg.result)
    })
  }

  call(payload: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`player ipc timeout ${payload.op}`)), timeoutMs)
      this.pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value) },
        reject(error) { clearTimeout(timer); reject(error) },
      })
      this.child.send({ id, ...payload })
    })
  }

  rpc(endpoint: string, payload: unknown = {}) {
    return this.call({ op: 'rpc', endpoint, payload })
  }

  snapshot() {
    return this.call({ op: 'snapshot' }) as Promise<Record<string, unknown>>
  }

  wait(field: string, timeoutMs = 90_000) {
    return this.call({ op: 'wait', field, timeoutMs, label: field }, timeoutMs + 5_000)
  }

  stream() {
    return this.call({ op: 'stream' }, 60_000) as Promise<Array<{ type: string; text?: string }>>
  }

  async dispose() {
    try { await this.call({ op: 'dispose' }, 5_000) } catch { /* already gone */ }
    if (!this.child.killed) this.child.kill('SIGTERM')
  }
}

function spawnPlayer(invite: string, url: string): Promise<PlayerProc> {
  const child = fork(playerFile, [], {
    cwd: pluginRoot,
    execArgv: ['--import', tsxLoader],
    env: {
      ...process.env,
      DSH_PLAYER: '1',
      DSH_VERSION: '0.1.0-rc.7',
      ARENA_WS_URL: url,
      ARENA_INVITE: invite,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  const stderr: string[] = []
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    stderr.push(text)
    process.stderr.write(`[player ${invite.slice(-2)}] ${text}`)
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`player boot timeout: ${stderr.join('')}`))
    }, 20_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      if (code) {
        clearTimeout(timer)
        reject(new Error(`player exited ${code}: ${stderr.join('')}`))
      }
    })
    child.on('message', (msg: { op?: string; error?: string }) => {
      if (msg.op === 'boot_error') {
        clearTimeout(timer)
        reject(new Error(msg.error ?? 'boot_error'))
        return
      }
      if (msg.op === 'booted') {
        clearTimeout(timer)
        resolve(new PlayerProc(child))
      }
    })
  })
}

describe('two-process DSH against live Arena', () => {
  it('plays friend-room through Grant redeem over the real relay', async () => {
    const url = await liveArenaUrl()
    if (!url) {
      if (process.env.CI === 'true' && process.env.ARENA_E2E !== '1') return
      throw new Error('live Arena is not reachable at ws://127.0.0.1:8787/v1/ws')
    }

    let hostProc: PlayerProc | undefined
    let guestProc: PlayerProc | undefined
    let hostLocal: DshHost | undefined
    let guestLocal: DshHost | undefined

    try {
      try {
        hostProc = await spawnPlayer('E2EHOSTINVITE01', url)
        guestProc = await spawnPlayer('E2EGUESTINVITE02', url)
      } catch {
        hostLocal = createDshHost({ serverUrl: url, inviteCode: 'E2EHOSTINVITE01' })
        guestLocal = createDshHost({ serverUrl: url, inviteCode: 'E2EGUESTINVITE02' })
        await hostLocal.wait((rt) => rt.store.snapshot.connectionState === 'ready', 20_000, 'host-auth')
        await guestLocal.wait((rt) => rt.store.snapshot.connectionState === 'ready', 20_000, 'guest-auth')
      }

      if (hostProc && guestProc) {
        const created = await hostProc.rpc('room.create', { provider: 'openai-compatible', model: 'local-a' }) as { ok: boolean; value?: { roomCode?: string } }
        expect(created.ok).toBe(true)
        const hostSnap = await hostProc.snapshot()
        const roomCode = String(hostSnap.roomCode ?? created.value?.roomCode ?? '')
        expect(roomCode).toMatch(/^[A-Z0-9]{6}$/)
        const joined = await guestProc.rpc('room.join', { roomCode, provider: 'openai-compatible', model: 'local-b' }) as { ok: boolean }
        expect(joined.ok).toBe(true)
        expect((await hostProc.rpc('room.accept', {}) as { ok: boolean }).ok).toBe(true)
        expect((await guestProc.rpc('room.accept', {}) as { ok: boolean }).ok).toBe(true)
        await Promise.all([
          hostProc.wait('result', 90_000),
          guestProc.wait('result', 90_000),
        ])
        await Promise.all([
          hostProc.wait('grants', 15_000),
          guestProc.wait('grants', 15_000),
        ])
        const hostAfter = await hostProc.snapshot()
        const guestAfter = await guestProc.snapshot()
        const hostGrants = hostAfter.grants as GrantV1[]
        const guestGrants = guestAfter.grants as GrantV1[]
        expect(hostGrants.length).toBeGreaterThan(0)
        expect(guestGrants.length).toBeGreaterThan(0)
        const winnerIsHost = hostGrants[0]?.winnerDeviceId === hostAfter.deviceId
        const chunks = winnerIsHost ? await hostProc.stream() : await guestProc.stream()
        expect(chunks.some((item) => item.type === 'text-delta' && item.text === 'reward-ok')).toBe(true)
        expect(chunks.some((item) => item.type === 'finish')).toBe(true)
        return
      }

      const host = hostLocal!
      const guest = guestLocal!
      const created = await host.rpc('room.create', { provider: 'openai-compatible', model: 'local-a' })
      expect(created.ok).toBe(true)
      await host.wait((rt) => Boolean(rt.store.snapshot.roomCode), 8_000, 'host-room')
      const roomCode = host.runtime.store.snapshot.roomCode!
      const joined = await guest.rpc('room.join', { roomCode, provider: 'openai-compatible', model: 'local-b' })
      expect(joined.ok).toBe(true)
      expect((await host.rpc('room.accept', {})).ok).toBe(true)
      expect((await guest.rpc('room.accept', {})).ok).toBe(true)
      await Promise.all([
        host.wait((rt) => Boolean(rt.store.snapshot.result), 90_000, 'host-result'),
        guest.wait((rt) => Boolean(rt.store.snapshot.result), 90_000, 'guest-result'),
      ])
      await Promise.all([
        host.wait((rt) => rt.store.snapshot.grants.length > 0, 15_000, 'host-grant'),
        guest.wait((rt) => rt.store.snapshot.grants.length > 0, 15_000, 'guest-grant'),
      ])
      const grant = host.runtime.store.snapshot.grants[0] as GrantV1
      const winner = grant.winnerDeviceId === host.runtime.store.snapshot.deviceId ? host : guest
      const chunks = await winner.streamReward(grant)
      expect(chunks.some((item) => item.type === 'text-delta' && item.text === 'reward-ok')).toBe(true)
      expect(chunks.some((item) => item.type === 'finish')).toBe(true)
    } finally {
      await hostProc?.dispose()
      await guestProc?.dispose()
      await hostLocal?.dispose()
      await guestLocal?.dispose()
    }
  }, 120_000)
})
