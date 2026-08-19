import { BLIND_SCHEDULE } from '@agent-colosseum/protocol'

export function blindsForHand(handNo: number): { small: number; big: number } {
  let small: number = BLIND_SCHEDULE[0]!.small
  let big: number = BLIND_SCHEDULE[0]!.big
  for (const row of BLIND_SCHEDULE) {
    if (handNo >= row.fromHand) {
      small = row.small
      big = row.big
    }
  }
  return { small, big }
}
