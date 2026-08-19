import { describe, expect, it } from 'vitest'
import { newDeviceId, newGrantId, newInferenceId } from '@agent-colosseum/protocol'
import { RelayController } from './relay.ts'
import { MemoryStore } from './store.ts'

async function seeded(overrides: Record<string, unknown> = {}) {
  const store = new MemoryStore()
  const grantId = newGrantId()
  const winner = newDeviceId()
  const owner = newDeviceId()
  await store.saveGrant({
    grantId,
    ownerDeviceId: owner,
    winnerDeviceId: winner,
    model: 'm',
    provider: 'openai-compatible',
    callsRemaining: 2,
    activeConcurrency: 0,
    onlineMsRemaining: 1000,
    ownerOnline: true,
    status: 'active',
    statusReason: 'active',
    version: 1,
    stakeId: 's',
    lastOnlineTickAt: null,
    ...overrides,
  })
  return { store, relay: new RelayController(store), grantId, winner, owner }
}

describe('relay branches', () => {
  it('rejects oversized, missing, unauthorized, exhausted, ttl and offline reserves', async () => {
    const { relay, grantId, winner } = await seeded()
    await expect(relay.reserve({
      grantId, inferenceId: newInferenceId(), winnerDeviceId: winner, requestBytes: 70_000, requestHash: 'h', ownerOnline: true,
    })).rejects.toThrow(/REQUEST_TOO_LARGE/)
    await expect(relay.reserve({
      grantId: newGrantId(), inferenceId: newInferenceId(), winnerDeviceId: winner, requestBytes: 8, requestHash: 'h', ownerOnline: true,
    })).rejects.toThrow(/GRANT_UNAVAILABLE/)
    await expect(relay.reserve({
      grantId, inferenceId: newInferenceId(), winnerDeviceId: newDeviceId(), requestBytes: 8, requestHash: 'h', ownerOnline: true,
    })).rejects.toThrow(/UNAUTHORIZED/)
    const ttl = await seeded({ status: 'exhausted', statusReason: 'ttl_exhausted', callsRemaining: 1 })
    await expect(ttl.relay.reserve({
      grantId: ttl.grantId, inferenceId: newInferenceId(), winnerDeviceId: ttl.winner, requestBytes: 8, requestHash: 'h', ownerOnline: true,
    })).rejects.toThrow(/TTL_EXHAUSTED/)
    const spent = await seeded({ status: 'exhausted', statusReason: 'calls_exhausted', callsRemaining: 0 })
    await expect(spent.relay.reserve({
      grantId: spent.grantId, inferenceId: newInferenceId(), winnerDeviceId: spent.winner, requestBytes: 8, requestHash: 'h', ownerOnline: true,
    })).rejects.toThrow(/GRANT_EXHAUSTED/)
    const zero = await seeded({ callsRemaining: 0, status: 'active' })
    await expect(zero.relay.reserve({
      grantId: zero.grantId, inferenceId: newInferenceId(), winnerDeviceId: zero.winner, requestBytes: 8, requestHash: 'h', ownerOnline: true,
    })).rejects.toThrow(/GRANT_EXHAUSTED/)
    await expect(relay.reserve({
      grantId, inferenceId: newInferenceId(), winnerDeviceId: winner, requestBytes: 8, requestHash: 'h', ownerOnline: false,
    })).rejects.toThrow(/OWNER_OFFLINE/)
  })

  it('covers preflight and terminal edges', async () => {
    const { relay, grantId, winner } = await seeded()
    const id = newInferenceId()
    await expect(relay.preflight(grantId, id, 'h')).rejects.toThrow(/not found/)
    const first = await relay.reserve({
      grantId, inferenceId: id, winnerDeviceId: winner, requestBytes: 8, requestHash: 'h', ownerOnline: true,
    })
    expect(first.created).toBe(true)
    const dup = await relay.reserve({
      grantId, inferenceId: id, winnerDeviceId: winner, requestBytes: 8, requestHash: 'h', ownerOnline: true,
    })
    expect(dup.created).toBe(false)
    await expect(relay.preflight(grantId, id, 'other')).rejects.toThrow(/REQUEST_HASH/)
    await relay.preflight(grantId, id, 'h')
    await relay.start(grantId, id)
    const again = await relay.preflight(grantId, id, 'h')
    expect(again.status).toBe('started')
    await expect(relay.terminal(newGrantId(), id, 'completed')).rejects.toThrow(/missing/)
    const done = await relay.terminal(grantId, id, 'completed', 'ok')
    expect(done.grant.activeConcurrency).toBe(0)
    const replay = await relay.terminal(grantId, id, 'cancelled')
    expect(replay.inference.status).toBe('completed')
    const other = newInferenceId()
    await relay.reserve({
      grantId, inferenceId: other, winnerDeviceId: winner, requestBytes: 8, requestHash: 'z', ownerOnline: true,
    })
    const undeducted = await relay.terminal(grantId, other, 'aborted')
    expect(undeducted.inference.status).toBe('aborted')
  })

  it('deductIfStarted rejects missing and exhausted grants', async () => {
    const store = new MemoryStore()
    await expect(store.deductIfStarted(newGrantId(), newInferenceId())).rejects.toThrow(/missing/)
  })
})
