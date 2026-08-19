import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState(init: unknown) {
      const value = typeof init === 'function' ? (init as () => unknown)() : init
      return [value, () => undefined]
    },
    useEffect(fn: () => void | (() => void)) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : undefined
    },
  }
})

import { ArenaApp, ArenaLauncher, ArenaOverlay, clientUi, type Snapshot } from './overlay.tsx'

function base(view: Snapshot['view'], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    view,
    privacyAcknowledged: view !== 'privacy',
    deviceId: 'd1',
    dshVersion: '0.1.0-rc.7',
    connectionState: 'ready',
    ownerOnline: true,
    disclosure: 'inspect',
    models: [{ provider: 'openai-compatible', model: 'local', name: 'local', allowedForStake: true }],
    grants: [],
    ...extra,
  }
}

function walk(node: unknown, visit: (el: { type: unknown; props: Record<string, unknown> }) => void): void {
  if (!node || typeof node !== 'object') return
  const el = node as { type?: unknown; props?: Record<string, unknown> }
  if (!el.props) return
  visit(el as { type: unknown; props: Record<string, unknown> })
  const children = el.props.children
  if (Array.isArray(children)) for (const child of children) walk(child, visit)
  else walk(children, visit)
}

describe('overlay views', () => {
  it('renders launcher, overlay pages, and invokes actions', async () => {
    const called: string[] = []
    const call = async (endpoint: string) => {
      called.push(endpoint)
      return base('lobby')
    }
    expect(ArenaLauncher({ wide: true })).toBeTruthy()
    expect(ArenaLauncher({})).toBeTruthy()
    const views: Snapshot['view'][] = ['privacy', 'lobby', 'room', 'table', 'result', 'grants', 'relay']
    for (const view of views) {
      const node = ArenaOverlay({
        state: base(view, {
          roomCode: 'ABC234',
          ...(view === 'table'
            ? {
              match: {
                handNo: 1, street: 'preflop', pot: 3, board: [], currentBet: 2, toAct: 'A',
                blinds: { small: 1, big: 2 }, seats: { A: { stack: 79 } }, lastActions: [{ publicRationale: 'ok' }],
              },
            }
            : {}),
          ...(view === 'result' ? { result: { reason: 'bust', winner: 'w' } } : {}),
          grants: view === 'grants'
            ? [{ grantId: 'g', model: 'm', callsRemaining: 2, ownerOnline: false, status: 'active', onlineMsRemaining: 1 }]
            : [],
          ...(view === 'relay' ? { relay: { status: 'started', error: 'x' } } : {}),
        }),
        error: view === 'lobby' ? 'rpc' : null,
        left: '',
        right: 'openai-compatible:local',
        roomCode: 'abc234',
        onLeft() {},
        onRight() {},
        onRoomCode() {},
        onClose() {},
        onState() {},
        call,
      })
      expect(node).toBeTruthy()
      const clicks: Array<() => unknown> = []
      walk(node, (el) => {
        if (typeof el.props.onClick === 'function') clicks.push(el.props.onClick as () => unknown)
        if (typeof el.props.onChange === 'function') {
          (el.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'x' } })
        }
      })
      for (const click of clicks) await click()
    }
    expect(ArenaOverlay({
      state: base('grants'),
      error: null,
      left: '',
      right: '',
      roomCode: '',
      onLeft() {},
      onRight() {},
      onRoomCode() {},
      onClose() {},
      onState() {},
      call,
    })).toBeTruthy()
    expect(ArenaOverlay({
      state: null,
      error: null,
      left: '',
      right: '',
      roomCode: '',
      onLeft() {},
      onRight() {},
      onRoomCode() {},
      onClose() {},
      onState() {},
      call,
    })).toBeTruthy()
    expect(called.length).toBeGreaterThan(0)
  })

  it('covers ArenaApp launcher, closed overlay, and bootstrap error', async () => {
    const rpc = {
      async call(_channel: string, endpoint: string) {
        if (endpoint === 'bootstrap') return { ok: false, error: { message: 'nope' } }
        return { ok: true, value: { events: [{ state: base('lobby') }] } }
      },
    }
    expect(ArenaApp({ rpc, wide: true, mode: 'launcher' })).toBeTruthy()
    clientUi.open = false
    expect(ArenaApp({ rpc, mode: 'overlay' })).toBeNull()
    clientUi.open = true
    ArenaApp({ rpc, mode: 'overlay' })
    await Promise.resolve()
    await Promise.resolve()
    clientUi.set(false)
  })
})
