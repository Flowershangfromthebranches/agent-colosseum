import { ArenaFooterAction, ArenaOverlay } from './overlay.tsx'

export const name = 'agent-colosseum-client'
export const inject = ['slots', 'connection']

type ClientCtx = {
  slots: {
    register(options: { name: string; id?: string; order?: number }, component: unknown): () => void
  }
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>
    }
  }
  effect(fn: () => () => void, label?: string): void
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const Footer = (props: { wide: boolean }) => ArenaFooterAction({ wide: props.wide, rpc: ctx.connection.rpc })
    const Overlay = () => ArenaOverlay({ rpc: ctx.connection.rpc })
    const offFooter = ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'agent-colosseum-footer',
      order: 40,
    }, Footer)
    const offOverlay = ctx.slots.register({
      name: 'shell.overlay',
      id: 'agent-colosseum-overlay',
      order: 40,
    }, Overlay)
    return () => {
      offFooter()
      offOverlay()
    }
  }, 'agent-colosseum: client slots')
}

export { ArenaOverlay, ArenaFooterAction }
