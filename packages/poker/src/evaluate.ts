import { evaluateStrings } from '@pokertools/evaluator'
import type { Seat } from './types.ts'

export function compareHoles(
  button: [string, string],
  bb: [string, string],
  board: readonly string[],
): Seat[] {
  const buttonScore = evaluateStrings([...button, ...board])
  const bbScore = evaluateStrings([...bb, ...board])
  if (buttonScore === bbScore) return ['button', 'bb']
  // evaluator: lower is better
  return buttonScore < bbScore ? ['button'] : ['bb']
}

export function assertUniqueCards(cards: readonly string[]): void {
  if (new Set(cards).size !== cards.length) {
    throw new Error('duplicate cards in play')
  }
}
