import { DEFAULT_MAX_CALLS, GRANT_ONLINE_TTL_SECONDS, newGrantId } from '@agent-colosseum/protocol'
import type { ArenaStore, GrantRecord } from './store.ts'

export async function settleMatch(store: ArenaStore, input: {
  matchId: string
  winnerDeviceId: string | null
  reason: string
}): Promise<GrantRecord | null> {
  const stakes = await store.listStakes(input.matchId)
  if (stakes.length !== 2) throw new Error('match must have exactly two stakes')
  const release = !input.winnerDeviceId || input.reason === 'double_disconnect' || input.reason === 'server_fault' || input.reason === 'draw_released'
  let grant: GrantRecord | undefined
  const stakeUpdates = stakes.map((stake) => {
    if (release) return { stakeId: stake.stakeId, status: 'released' as const }
    if (stake.spec.ownerDeviceId === input.winnerDeviceId) return { stakeId: stake.stakeId, status: 'unlocked' as const }
    grant = {
      grantId: newGrantId(),
      ownerDeviceId: stake.spec.ownerDeviceId,
      winnerDeviceId: input.winnerDeviceId!,
      model: stake.spec.model,
      provider: stake.spec.provider,
      callsRemaining: DEFAULT_MAX_CALLS,
      activeConcurrency: 0,
      onlineMsRemaining: GRANT_ONLINE_TTL_SECONDS * 1000,
      ownerOnline: false,
      status: 'active',
      statusReason: 'active',
      version: 1,
      stakeId: stake.stakeId,
      lastOnlineTickAt: null,
    }
    return { stakeId: stake.stakeId, status: 'converted' as const }
  })
  const result = await store.settleInTransaction({
    matchId: input.matchId,
    winnerDeviceId: input.winnerDeviceId,
    reason: input.reason,
    ...grant ? { grant } : {},
    stakeUpdates,
  })
  return result.grant
}

export async function tickGrantOnline(store: ArenaStore, grant: GrantRecord, ownerOnline: boolean, now = Date.now()): Promise<GrantRecord> {
  if (grant.status !== 'active') return { ...grant, ownerOnline }
  if (ownerOnline) {
    if (grant.lastOnlineTickAt !== null) {
      grant.onlineMsRemaining = Math.max(0, grant.onlineMsRemaining - Math.max(0, now - grant.lastOnlineTickAt))
    }
    grant.lastOnlineTickAt = now
    grant.ownerOnline = true
    if (grant.onlineMsRemaining === 0) {
      grant.status = 'exhausted'
      grant.statusReason = 'ttl_exhausted'
    }
  } else {
    grant.ownerOnline = false
    grant.lastOnlineTickAt = null
  }
  grant.version += 1
  await store.saveGrant(grant)
  return grant
}
