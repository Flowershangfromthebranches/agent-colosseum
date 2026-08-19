import {
  DEFAULT_MAX_CALLS,
  GRANT_ONLINE_TTL_SECONDS,
  newGrantId,
  type Grant,
} from '@agent-colosseum/protocol'
import type { ArenaStore, GrantRecord, StakeRecord } from './store.ts'

export interface SettlementInput {
  matchId: string
  winnerDeviceId: string | null
  reason: 'bust' | 'chip_lead' | 'forfeit' | 'double_disconnect' | 'server_fault' | 'draw_released'
}

export async function settleMatch(store: ArenaStore, input: SettlementInput): Promise<Grant | null> {
  const first = await store.settleMatch(input.matchId, input.winnerDeviceId)
  if (!first) return null
  const stakes = await store.listStakes(input.matchId)
  if (stakes.length !== 2) throw new Error('match must have exactly two stakes')

  if (!input.winnerDeviceId || input.reason === 'double_disconnect' || input.reason === 'server_fault' || input.reason === 'draw_released') {
    for (const stake of stakes) await store.updateStake(stake.stakeId, 'released')
    return null
  }

  let grant: Grant | null = null
  for (const stake of stakes) {
    if (stake.spec.ownerDeviceId === input.winnerDeviceId) {
      await store.updateStake(stake.stakeId, 'unlocked')
    } else {
      await store.updateStake(stake.stakeId, 'converted')
      grant = await convertStake(store, stake, input.winnerDeviceId)
    }
  }
  return grant
}

async function convertStake(store: ArenaStore, stake: StakeRecord, winnerDeviceId: string): Promise<Grant> {
  const now = Date.now()
  const record: GrantRecord = {
    grantId: newGrantId(),
    ownerDeviceId: stake.spec.ownerDeviceId,
    winnerDeviceId,
    model: stake.spec.model,
    provider: stake.spec.provider,
    callsRemaining: DEFAULT_MAX_CALLS,
    onlineMsRemaining: GRANT_ONLINE_TTL_SECONDS * 1000,
    ownerOnline: false,
    status: 'active',
    version: 1,
    stakeId: stake.stakeId,
    lastOnlineTickAt: null,
  }
  await store.putGrant(record)
  return record
}

export async function tickGrantOnline(store: ArenaStore, grant: GrantRecord, ownerOnline: boolean, now = Date.now()): Promise<GrantRecord> {
  if (grant.status !== 'active') {
    return { ...grant, ownerOnline }
  }
  if (ownerOnline) {
    if (grant.lastOnlineTickAt !== null) {
      const elapsed = Math.max(0, now - grant.lastOnlineTickAt)
      grant.onlineMsRemaining = Math.max(0, grant.onlineMsRemaining - elapsed)
    }
    grant.lastOnlineTickAt = now
    grant.ownerOnline = true
    if (grant.onlineMsRemaining === 0) grant.status = 'exhausted'
  } else {
    grant.ownerOnline = false
    grant.lastOnlineTickAt = null
  }
  grant.version += 1
  await store.saveGrant(grant)
  return grant
}
