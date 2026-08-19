import { ArenaApp } from './overlay.tsx'

export const name = 'agent-colosseum-client'
export const inject = ['slots', 'connection']

type ClientCtx = {
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: { name: string; id?: string; order?: number }, component: unknown): () => void
  }
  connection: { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }> } }
  effect(fn: () => () => void, label?: string): void
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const offFooter = ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({ name: 'sidebar.footer.action', id: 'agent-colosseum-footer', order: 40 },
        (props: { wide: boolean }) => ArenaApp({ rpc: ctx.connection.rpc, wide: props.wide, mode: 'launcher' })))
    const offOverlay = ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'agent-colosseum-overlay', order: 40 },
        () => ArenaApp({ rpc: ctx.connection.rpc, mode: 'overlay' })))
    return () => { offFooter(); offOverlay() }
  }, 'agent-colosseum: client slots')
}

export { ArenaApp }
