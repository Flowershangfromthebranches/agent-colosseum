import { useEffect, useMemo, useState } from 'react'
import { RPC_CHANNEL } from '@agent-colosseum/protocol'

type ArenaState = {
  view: 'privacy' | 'lobby' | 'table' | 'result' | 'grants'
  privacyAcknowledged: boolean
  deviceId: string
  dshVersion: string
  serverReachable: boolean
  ownerOnline: boolean
  roomCode?: string
  match?: {
    handNo: number
    street: string
    pot: number
    board: string[]
    stacks: { button: number; bb: number }
    legal: Array<{ action: string }>
    toAct: string | null
  }
  result?: { winner?: string; reason?: string }
  grants: Array<{
    grantId: string
    model: string
    callsRemaining: number
    ownerOnline: boolean
    status: string
    onlineMsRemaining: number
  }>
  localModels: Array<{ provider: string; model: string; name: string; allowedForStake: boolean }>
  disclosure: string
}

type Rpc = {
  call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>
}

export function ArenaOverlay(props: { wide?: boolean; rpc: Rpc; onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ArenaState | null>(null)
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
    let cancelled = false
    const poll = async () => {
      try {
        const value = await call('events.poll', { cursor: 0, timeoutMs: 1000 }) as { events?: Array<{ state?: ArenaState }> }
        const next = value.events?.at(-1)?.state
        if (next && !cancelled) setState(next)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void call('bootstrap').then((value) => setState(value as ArenaState)).catch((err) => setError(String(err)))
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [open])

  const models = state?.localModels ?? []
  const leftValue = left || models[0] ? `${models[0]?.provider ?? ''}:${models[0]?.model ?? ''}` : ''
  const parsed = (value: string) => {
    const [provider, model] = value.split(':')
    return { provider: provider || 'script', model: model || 'script-a' }
  }

  if (!open) {
    return (
      <button type="button" className="ac-launch" onClick={() => setOpen(true)} style={launchStyle(props.wide)}>
        {props.wide ? 'Colosseum' : 'AC'}
      </button>
    )
  }

  return (
    <div style={shellStyle} role="dialog" aria-label="Agent Colosseum">
      <header style={headerStyle}>
        <strong>Agent Colosseum</strong>
        <button type="button" onClick={() => { setOpen(false); props.onClose?.() }}>Close</button>
      </header>
      {error && <p style={{ color: '#b42318' }}>{error}</p>}
      {!state && <p>Loading host state…</p>}
      {state?.view === 'privacy' && (
        <section>
          <h2>Privacy</h2>
          <p>{state.disclosure}</p>
          <p>This plugin never reads, uploads, or forwards API keys. Device private keys stay in DSH credentials.</p>
          <button type="button" onClick={async () => setState(await call('privacy.ack') as ArenaState)}>I understand</button>
        </section>
      )}
      {state && state.view !== 'privacy' && (
        <nav style={navStyle}>
          <button type="button" onClick={() => setState({ ...state, view: 'lobby' })}>Lobby</button>
          <button type="button" onClick={() => setState({ ...state, view: 'grants' })}>Grants</button>
        </nav>
      )}
      {state?.view === 'lobby' && (
        <section>
          <h2>Local practice</h2>
          <label>Left model
            <select value={left || leftValue} onChange={(event: { target: { value: string } }) => setLeft(event.target.value)}>
              {models.map((model) => (
                <option key={`${model.provider}:${model.model}`} value={`${model.provider}:${model.model}`}>
                  {model.name}{model.allowedForStake ? '' : ' (practice only)'}
                </option>
              ))}
              <option value="script:script-a">script / check-fold</option>
              <option value="script:script-b">script / call-station</option>
            </select>
          </label>
          <label>Right model
            <select value={right || 'script:script-b'} onChange={(event: { target: { value: string } }) => setRight(event.target.value)}>
              {models.map((model) => (
                <option key={`r-${model.provider}:${model.model}`} value={`${model.provider}:${model.model}`}>
                  {model.name}
                </option>
              ))}
              <option value="script:script-a">script / check-fold</option>
              <option value="script:script-b">script / call-station</option>
            </select>
          </label>
          <button type="button" onClick={async () => {
            setState(await call('match.local.start', { left: parsed(left || 'script:script-a'), right: parsed(right || 'script:script-b') }) as ArenaState)
          }}>Start local match</button>
          <h2>Friend room</h2>
          <p>Create a room on the Arena Server, then share the six-character code. Both sides confirm the same 10-call stake.</p>
          <button type="button" onClick={async () => {
            const created = await call('room.create', parsed(left || 'script:script-a')) as { stake?: unknown }
            setState({ ...state, view: 'lobby', roomCode: 'pending server' })
            void created
          }}>Create room</button>
          <label>Join code
            <input value={roomCode} onChange={(event: { target: { value: string } }) => setRoomCode(event.target.value.toUpperCase())} maxLength={6} />
          </label>
          <button type="button" onClick={async () => {
            await call('room.join', { roomCode, ...parsed(left || 'script:script-a') })
          }}>Join</button>
        </section>
      )}
      {state?.view === 'table' && state.match && (
        <section>
          <h2>Hand {state.match.handNo} · {state.match.street}</h2>
          <p>Board: {state.match.board.join(' ') || '(preflop)'}</p>
          <p>Pot {state.match.pot} · BTN {state.match.stacks.button} · BB {state.match.stacks.bb}</p>
          <p>To act: {state.match.toAct ?? '—'}</p>
        </section>
      )}
      {state?.view === 'result' && (
        <section>
          <h2>Result</h2>
          <p>{state.result?.reason} {state.result?.winner ? `· winner ${state.result.winner}` : ''}</p>
        </section>
      )}
      {state?.view === 'grants' && (
        <section>
          <h2>Grant inventory</h2>
          {state.grants.length === 0 && <p>No grants yet.</p>}
          <ul>
            {state.grants.map((grant) => (
              <li key={grant.grantId}>
                {grant.model} · {grant.callsRemaining} calls · {grant.ownerOnline ? 'owner online' : 'unavailable (TTL paused)'} · {grant.status}
              </li>
            ))}
          </ul>
          <p>Relay uses the owner&apos;s existing <code>ctx.llm.stream()</code>. Keys never leave their machine.</p>
        </section>
      )}
      <footer style={{ opacity: 0.7, marginTop: 24, fontSize: 12 }}>
        Device {state?.deviceId || '…'} · DSH {state?.dshVersion} · no cash, credits, or transfers
      </footer>
    </div>
  )
}

export function ArenaFooterAction(props: { wide: boolean; rpc: Rpc }) {
  return <ArenaOverlay wide={props.wide} rpc={props.rpc} />
}

type Css = Record<string, string | number>

const launchStyle = (wide?: boolean): Css => ({
  pointerEvents: 'auto',
  border: '1px solid #d0d5dd',
  background: '#fff',
  borderRadius: 8,
  padding: wide ? '8px 12px' : 8,
  cursor: 'pointer',
})

const shellStyle: Css = {
  pointerEvents: 'auto',
  position: 'fixed',
  inset: 16,
  maxWidth: 720,
  margin: '0 auto',
  background: '#fffaf3',
  color: '#1a1a1a',
  border: '1px solid #d6c7b2',
  borderRadius: 16,
  padding: 20,
  overflow: 'auto',
  boxShadow: '0 16px 60px rgba(0,0,0,.18)',
  zIndex: 40,
}

const headerStyle: Css = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 16,
}

const navStyle: Css = { display: 'flex', gap: 8, marginBottom: 12 }

export function useRpcFromCtx(ctx: { connection?: { rpc: Rpc } }): Rpc {
  return useMemo(() => ctx.connection?.rpc ?? {
    async call() {
      return { ok: false, error: { message: 'connection rpc unavailable' } }
    },
  }, [ctx.connection])
}
