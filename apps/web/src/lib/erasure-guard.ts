export type ErasureRefusal = 'not-owner' | 'confirmation-mismatch'

export interface ErasureRequestCheck {
  role: string
  typed: string
  expected: string
}

/**
 * Deleting a tenant is the one action with no undo, so it is the one action an admin
 * cannot take. The typed confirmation is checked on the server for the same reason a
 * confirmation dialog is not enough: a confirmation the client enforces is one that
 * anybody bypassing the client never has to give.
 */
export const checkErasureRequest = (input: ErasureRequestCheck): ErasureRefusal | null => {
  if (input.role !== 'owner') return 'not-owner'

  const typed = input.typed.trim()
  // An empty expectation would otherwise be satisfied by an empty box — a confirmation
  // nobody has to make.
  if (typed.length === 0 || typed !== input.expected) return 'confirmation-mismatch'

  return null
}
