import { useEffect, useState } from 'react'
import { RPC_CHANNEL } from '@agent-colosseum/protocol'

type Snapshot = {
  view: 'privacy' | 'lobby' | 'room' | 'table' | 'result' | 'grants' | 'relay'
  privacyAcknowledged: boolean
  deviceId: string | null
  dshVersion: string
  connectionState: string
  ownerOnline: boolean
  roomCode?: string
  disclosure: string
  error?: string
  models: Array<{ provider: string; model: string; name: string; allowedForStake: boolean }>
  match?: {
    handNo?: number
    street?: string
    pot?: number
    board?: string[]
    currentBet?: number
    toAct?: string | null
    blinds?: { small: number; big: number }
    seats?: Record<string, { stack: number }>
    lastActions?: Array<{ publicRationale?: string }>
  }
  result?: { winner?: string; reason?: string }
  grants: Array<{ grantId: string; model: string; callsRemaining: number; ownerOnline: boolean; status: string; statusReason?: string; onlineMsRemaining: number }>
  relay?: { status?: string; error?: string }
}

type Rpc = { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }> }

const clientUi = {
  open: false,
  listeners: new Set<() => void>(),
  set(open: boolean) {
    this.open = open
    for (const listener of this.listeners) listener()
  },
}

export function ArenaApp(props: { rpc: Rpc; wide?: boolean; mode: 'launcher' | 'overlay' }) {
  const [open, setOpen] = useState(clientUi.open)
  useEffect(() => {
    const sync = () => setOpen(clientUi.open)
    clientUi.listeners.add(sync)
    return () => { clientUi.listeners.delete(sync) }
  }, [])
  const [state, setState] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [roomCode, setRoomCode] = useState('')

  const call = async (endpoint: string, payload: unknown = {}) => {
    const result = await props.rpc.call(RPC_CHANNEL, endpoint, payload)
    if (!result.ok) throw new Error(result.error?.message ?? 'rpc failed')
    return result.value
  }

  useEffect(() => {
    if (!open) return
    let live = true
    void call('bootstrap').then((value) => { if (live) setState(value as Snapshot) }).catch((err: Error) => setError(err.message))
    const timer = setInterval(() => {
      void call('events.poll', { cursor: 0, timeoutMs: 1000 }).then((value) => {
        const next = (value as { events?: Array<{ state?: Snapshot }> }).events?.at(-1)?.state
        if (next && live) setState(next)
      }).catch(() => undefined)
    }, 1500)
    return () => { live = false; clearInterval(timer) }
  }, [open])

  if (props.mode === 'launcher') {
    return (
      <button type="button" className="ac-open" onClick={() => clientUi.set(true)} style={btn}>
        {props.wide ? 'Colosseum' : 'AC'}
      </button>
    )
  }

  if (!open) return null

  const models = state?.models ?? []
  const parse = (value: string) => {
    const [provider, model] = value.split(':')
    return { provider: provider || models[0]?.provider || 'openai-compatible', model: model || models[0]?.model || 'local' }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Agent Colosseum" style={shell}>
      <header style={header}>
        <strong>Agent Colosseum</strong>
        <span>{state?.connectionState ?? 'idle'}</span>
        <button type="button" onClick={() => clientUi.set(false)}>Close</button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {state?.error ? <p role="alert">{state.error}</p> : null}
      {state && (
        <nav style={nav}>
          {(['lobby', 'room', 'table', 'result', 'grants', 'relay'] as const).map((view) => (
            <button key={view} type="button" onClick={() => setState({ ...state, view })}>{view}</button>
          ))}
        </nav>
      )}
      {state?.view === 'privacy' && (
        <section>
          <h2>Privacy</h2>
          <p>{state.disclosure}</p>
          <button type="button" onClick={async () => setState(await call('privacy.ack') as Snapshot)}>I understand / 我已了解</button>
        </section>
      )}
      {state?.view === 'lobby' && (
        <section>
          <h2>Lobby</h2>
          <label>Left
            <select value={left} onChange={(event: { target: { value: string } }) => setLeft(event.target.value)}>
              {models.map((model) => <option key={`l-${model.provider}:${model.model}`} value={`${model.provider}:${model.model}`}>{model.name}</option>)}
            </select>
          </label>
          <label>Right
            <select value={right} onChange={(event: { target: { value: string } }) => setRight(event.target.value)}>
              {models.map((model) => <option key={`r-${model.provider}:${model.model}`} value={`${model.provider}:${model.model}`}>{model.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={async () => setState(await call('match.local.start', { left: parse(left), right: parse(right) }) as Snapshot)}>Start local match</button>
          <h3>Friend room</h3>
          <button type="button" onClick={async () => setState(await call('room.create', parse(left)) as Snapshot)}>Create room</button>
          <input aria-label="Room code" value={roomCode} maxLength={6} onChange={(event: { target: { value: string } }) => setRoomCode(event.target.value.toUpperCase())} />
          <button type="button" onClick={async () => setState(await call('room.join', { roomCode, ...parse(left) }) as Snapshot)}>Join</button>
        </section>
      )}
      {state?.view === 'room' && (
        <section>
          <h2>Room {state.roomCode}</h2>
          <p>Confirm both models and the 10-call stake before accepting.</p>
          <button type="button" onClick={async () => setState(await call('room.accept') as Snapshot)}>Accept</button>
          <button type="button" onClick={async () => setState(await call('room.leave') as Snapshot)}>Leave</button>
        </section>
      )}
      {state?.view === 'table' && state.match && (
        <section>
          <h2>Hand {state.match.handNo} · {state.match.street}</h2>
          <p>Blinds {state.match.blinds?.small}/{state.match.blinds?.big} · Pot {state.match.pot} · Bet {state.match.currentBet}</p>
          <p>Board: {(state.match.board ?? []).join(' ') || '(preflop)'}</p>
          <p>Stacks: {Object.entries(state.match.seats ?? {}).map(([seat, info]) => `${seat} ${info.stack}`).join(' · ')}</p>
          <p>To act: {state.match.toAct ?? '—'}</p>
          <p>{state.match.lastActions?.at(-1)?.publicRationale}</p>
        </section>
      )}
      {state?.view === 'result' && (
        <section>
          <h2>Result</h2>
          <p>{state.result?.reason} {state.result?.winner ?? ''}</p>
        </section>
      )}
      {state?.view === 'grants' && (
        <section>
          <h2>Grant inventory</h2>
          {state.grants.length === 0 ? <p>No grants.</p> : (
            <ul>{state.grants.map((grant) => (
              <li key={grant.grantId}>{grant.model} · {grant.callsRemaining} · {grant.ownerOnline ? 'online' : 'unavailable'} · {grant.statusReason ?? grant.status}</li>
            ))}</ul>
          )}
        </section>
      )}
      {state?.view === 'relay' && (
        <section>
          <h2>Relay</h2>
          <p>{state.relay?.status ?? 'idle'} {state.relay?.error ?? ''}</p>
        </section>
      )}
      <footer style={{ opacity: 0.7, fontSize: 12 }}>Device {state?.deviceId ?? '…'} · DSH {state?.dshVersion} · no cash</footer>
    </div>
  )
}

const btn: Record<string, string | number> = { pointerEvents: 'auto', border: '1px solid var(--dsh-border, #ccc)', background: 'var(--dsh-surface, #fff)', borderRadius: 8, padding: 8 }
const shell: Record<string, string | number> = { pointerEvents: 'auto', position: 'fixed', inset: 16, maxWidth: 760, margin: '0 auto', background: 'var(--dsh-bg, #fffaf3)', color: 'var(--dsh-fg, #1a1a1a)', border: '1px solid var(--dsh-border, #d6c7b2)', borderRadius: 16, padding: 20, overflow: 'auto', zIndex: 40 }
const header: Record<string, string | number> = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const nav: Record<string, string | number> = { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' }
