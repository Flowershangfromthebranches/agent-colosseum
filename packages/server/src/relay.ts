import { MAX_REQUEST_BYTES } from '@agent-colosseum/protocol'
import type { ArenaStore, GrantRecord } from './store.ts'
import type { MemoryStore } from './store.ts'

export class RelayController {
  constructor(private readonly store: ArenaStore) {}

  async reserve(input: {
    grantId: string
    inferenceId: string
    winnerDeviceId: string
    requestBytes: number
    requestHash: string
    ownerOnline: boolean
  }) {
    if (input.requestBytes > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE')
    const grant = await this.store.getGrant(input.grantId)
    if (!grant) throw new Error('GRANT_UNAVAILABLE')
    if (grant.winnerDeviceId !== input.winnerDeviceId) throw new Error('UNAUTHORIZED')
    if (grant.status !== 'active') throw new Error(grant.statusReason === 'ttl_exhausted' ? 'TTL_EXHAUSTED' : 'GRANT_EXHAUSTED')
    if (grant.callsRemaining <= 0) throw new Error('GRANT_EXHAUSTED')
    if (!input.ownerOnline) throw new Error('OWNER_OFFLINE')
    const created = await this.store.insertInference({
      grantId: input.grantId,
      inferenceId: input.inferenceId,
      requesterDeviceId: input.winnerDeviceId,
      ownerDeviceId: grant.ownerDeviceId,
      status: 'reserved',
      deducted: false,
      requestHash: input.requestHash,
      startedAt: null,
      finishedAt: null,
      terminalReason: null,
    })
    const inference = (await this.store.getInference(input.grantId, input.inferenceId))!
    return { grant, inference, created: created === 'created' }
  }

  async preflight(grantId: string, inferenceId: string, requestHash: string) {
    const inference = await this.store.getInference(grantId, inferenceId)
    if (!inference) throw new Error('inference not found')
    if (inference.requestHash !== requestHash) throw new Error('REQUEST_HASH')
    if (inference.status === 'started' || inference.deducted) return inference
    inference.status = 'preflight'
    await this.store.updateInference(inference)
    return inference
  }

  async start(grantId: string, inferenceId: string): Promise<GrantRecord> {
    const memory = this.store as MemoryStore
    if (typeof memory.deductIfStarted === 'function') {
      return memory.deductIfStarted(grantId, inferenceId)
    }
    const grant = await this.store.getGrant(grantId)
    const inference = await this.store.getInference(grantId, inferenceId)
    if (!grant || !inference) throw new Error('missing')
    if (inference.deducted) return grant
    if (grant.callsRemaining <= 0) throw new Error('GRANT_EXHAUSTED')
    if (grant.activeConcurrency >= 1) throw new Error('CONCURRENCY')
    grant.callsRemaining -= 1
    grant.activeConcurrency += 1
    grant.version += 1
    inference.deducted = true
    inference.status = 'started'
    inference.startedAt = Date.now()
    await this.store.saveGrant(grant)
    await this.store.updateInference(inference)
    return grant
  }

  async terminal(grantId: string, inferenceId: string, status: 'completed' | 'cancelled' | 'provider_error' | 'aborted', reason?: string) {
    const inference = await this.store.getInference(grantId, inferenceId)
    const grant = await this.store.getGrant(grantId)
    if (!inference || !grant) throw new Error('missing')
    if (inference.finishedAt) return { inference, grant }
    inference.status = status
    inference.finishedAt = Date.now()
    inference.terminalReason = reason ?? status
    if (grant.activeConcurrency > 0 && inference.deducted) grant.activeConcurrency -= 1
    grant.version += 1
    await this.store.updateInference(inference)
    await this.store.saveGrant(grant)
    return { inference, grant }
  }
}
