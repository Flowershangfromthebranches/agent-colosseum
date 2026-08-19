import { MAX_REQUEST_BYTES } from '@agent-colosseum/protocol'
import type { ArenaStore, GrantRecord, InferenceRecord } from './store.ts'

export type RelayPhase =
  | 'reserved'
  | 'preflight'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'provider_error'
  | 'aborted'

export class RelayController {
  constructor(private readonly store: ArenaStore) {}

  async reserve(input: {
    grantId: string
    inferenceId: string
    winnerDeviceId: string
    requestBytes: number
    estimatedInputTokens: number
    ownerOnline: boolean
  }): Promise<{ grant: GrantRecord; inference: InferenceRecord; created: boolean }> {
    if (input.requestBytes > MAX_REQUEST_BYTES) throw new Error('request too large')
    const grant = await this.store.getGrant(input.grantId)
    if (!grant) throw new Error('grant not found')
    if (grant.winnerDeviceId !== input.winnerDeviceId) throw new Error('not grant winner')
    if (grant.status !== 'active') throw new Error(`grant ${grant.status}`)
    if (grant.callsRemaining <= 0) throw new Error('grant exhausted')
    if (!input.ownerOnline) throw new Error('owner offline')

    const created = await this.store.reserveInference({
      grantId: input.grantId,
      inferenceId: input.inferenceId,
      status: 'reserved',
      deducted: false,
      createdAt: Date.now(),
    })
    const inference = (await this.store.getInference(input.grantId, input.inferenceId))!
    return { grant, inference, created: created === 'created' }
  }

  async inferenceStarted(grantId: string, inferenceId: string): Promise<GrantRecord> {
    const inference = await this.store.getInference(grantId, inferenceId)
    const grant = await this.store.getGrant(grantId)
    if (!inference || !grant) throw new Error('inference or grant missing')
    if (inference.deducted) {
      if (inference.status === 'reserved') {
        await this.store.updateInference(grantId, inferenceId, { status: 'started' })
      }
      return grant
    }
    if (grant.callsRemaining <= 0) throw new Error('grant exhausted')
    grant.callsRemaining -= 1
    grant.version += 1
    if (grant.callsRemaining === 0) grant.status = 'exhausted'
    inference.deducted = true
    inference.status = 'started'
    await this.store.saveGrant(grant)
    await this.store.updateInference(grantId, inferenceId, inference)
    return grant
  }

  async terminal(
    grantId: string,
    inferenceId: string,
    status: Exclude<InferenceRecord['status'], 'reserved' | 'started'>,
  ): Promise<InferenceRecord> {
    const inference = await this.store.getInference(grantId, inferenceId)
    if (!inference) throw new Error('inference not found')
    if (inference.status === 'completed' || inference.status === 'cancelled' || inference.status === 'provider_error' || inference.status === 'aborted') {
      return inference
    }
    return this.store.updateInference(grantId, inferenceId, { status })
  }
}
