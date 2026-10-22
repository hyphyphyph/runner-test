// The free allowance shown in the naming workspace.
//
// The specification (Limits) says every counted limit is an operator setting,
// never a fixed number in the product. The admin settings and their API route
// are built separately, so this module holds the shipped starting values from
// Limits.defaults. The page reads them through one function, which is the
// place a later settings route plugs into without changing the view.

import type { AnonymousUsage } from './types.ts'

/** The shipped free allowance: 5 rounds, 3 revisions and 36 checks a month. */
export interface AllowanceLimits {
  rounds: number
  revisions: number
  checks: number
}

/** What the page shows in the always-visible allowance slot. */
export interface RemainingAllowance {
  rounds: number
  revisions: number
  checks: number
  limits: AllowanceLimits
}

/** Limits.defaults, kept in one place until the settings route reaches the page. */
export const SHIPPED_FREE_ALLOWANCE: Readonly<AllowanceLimits> = Object.freeze({
  rounds: 5,
  revisions: 3,
  checks: 36,
})

/**
 * The free allowance still available this month.
 *
 * A counter that has passed its limit reads as zero rather than a negative
 * number, so the slot never promises an allowance the counters do not hold.
 * The limits themselves are returned too, so a caller can say "of five".
 */
export function remainingAllowance(
  usage: Pick<AnonymousUsage, 'rounds' | 'revisions' | 'checks'>,
  limits: AllowanceLimits = SHIPPED_FREE_ALLOWANCE,
): RemainingAllowance {
  return {
    rounds: Math.max(0, limits.rounds - usage.rounds),
    revisions: Math.max(0, limits.revisions - usage.revisions),
    checks: Math.max(0, limits.checks - usage.checks),
    limits: { ...limits },
  }
}

/** True when at least one generation round's worth of allowance remains. */
export function hasRoundLeft(remaining: RemainingAllowance, cost = 1): boolean {
  return remaining.rounds >= Math.max(1, cost)
}
