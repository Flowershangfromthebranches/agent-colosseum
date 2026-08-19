import { evaluateStrings } from '@pokertools/evaluator'
import type { SeatId } from '@agent-colosseum/protocol'

export function compareHoles(
  a: [string, string],
  b: [string, string],
  board: readonly string[],
): SeatId[] {
  const aScore = evaluateStrings([...a, ...board])
  const bScore = evaluateStrings([...b, ...board])
  if (aScore === bScore) return ['A', 'B']
  return aScore < bScore ? ['A'] : ['B']
}

export function assertUniqueCards(cards: readonly string[]): void {
  if (new Set(cards).size !== cards.length) throw new Error('duplicate cards in play')
}
