// Counted allowance arithmetic shared by the browser and the server.
//
// The specification (FreeAllowance, Limits) says the counters refresh every
// month on the day of the first visit, that a round can spend more than one
// round at a higher effort, and that a check is one name and ending pair.
// These helpers are deliberately free of storage and of the DOM: the browser
// store and the server store both call them, so a refresh or a cost cannot
// mean one thing in one place and something else in the other.

/** The three counters of the free allowance and of a plan allowance. */
export type AllowanceCounter = 'rounds' | 'revisions' | 'checks'

/** Every counter counted against an allowance. */
export interface AllowanceCounts {
  rounds: number
  revisions: number
  checks: number
}

/** The shipped free allowance from Limits.defaults. */
export interface AllowanceLimits extends AllowanceCounts {}

/** A cost to take from the counters. A missing counter costs zero. */
export interface AllowanceCost {
  rounds?: number
  revisions?: number
  checks?: number
}

/** A cost with every counter present, after validation. */
export interface FullAllowanceCost extends AllowanceCounts {}

/** What the page shows in the always-visible allowance slot. */
export interface RemainingAllowance extends AllowanceCounts {
  limits: AllowanceLimits
}

/** Limits.defaults, kept in one place until the settings route reaches the page. */
export const SHIPPED_FREE_ALLOWANCE: Readonly<AllowanceLimits> = Object.freeze({
  rounds: 5,
  revisions: 3,
  checks: 36,
})

const COUNTERS: readonly AllowanceCounter[] = ['rounds', 'revisions', 'checks']

/** True for one of the three counted names. */
export function isAllowanceCounter(value: unknown): value is AllowanceCounter {
  return value === 'rounds' || value === 'revisions' || value === 'checks'
}

/**
 * Check and normalise a cost. Every present amount must be a whole number of
 * zero or more. Throws a RangeError with a plain message otherwise.
 */
export function normalizeAllowanceCost(cost: AllowanceCost): FullAllowanceCost {
  const result: FullAllowanceCost = { rounds: 0, revisions: 0, checks: 0 }
  for (const counter of COUNTERS) {
    const amount = cost[counter] ?? 0
    if (!Number.isInteger(amount) || amount < 0) {
      throw new RangeError(`A ${counter} cost must be a whole number of zero or more.`)
    }
    result[counter] = amount
  }
  return result
}

/** True when no counter in a cost would move. */
export function isZeroCost(cost: AllowanceCost): boolean {
  const full = normalizeAllowanceCost(cost)
  return full.rounds === 0 && full.revisions === 0 && full.checks === 0
}

/**
 * The free allowance still available this month.
 *
 * A counter that has passed its limit reads as zero rather than a negative
 * number, so the slot never promises an allowance the counters do not hold.
 * The limits themselves are returned too, so a caller can say "of five".
 */
export function remainingAllowance(
  usage: AllowanceCounts,
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

/**
 * The allowance period that contains `now`, given the day of the month on
 * which the person first visited. The period begins on that day each month,
 * clamped to the last day of a shorter month.
 */
export interface AllowancePeriod {
  /** The month the period began in, written as YYYY-MM. */
  key: string
  /** First millisecond of the period. */
  start: number
  /** First millisecond of the next period, when the counters refresh. */
  end: number
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`
}

function periodStart(year: number, month: number, anchorDay: number): number {
  const day = Math.min(anchorDay, lastDayOfMonth(year, month))
  return Date.UTC(year, month, day)
}

/** Clamp a first-visit day to 1..31. A damaged value becomes day 1. */
export function clampAnchorDay(day: number): number {
  if (!Number.isInteger(day)) return 1
  return Math.min(31, Math.max(1, day))
}

/** The period key and its two boundaries for `now`. */
export function allowancePeriodBounds(now: number, anchorDay: number): AllowancePeriod {
  const anchor = clampAnchorDay(anchorDay)
  const date = new Date(now)
  let year = date.getUTCFullYear()
  let month = date.getUTCMonth()

  let start = periodStart(year, month, anchor)
  if (start > now) {
    month -= 1
    if (month < 0) {
      month = 11
      year -= 1
    }
    start = periodStart(year, month, anchor)
  }

  const nextYear = month === 11 ? year + 1 : year
  const nextMonth = (month + 1) % 12
  return {
    key: monthKey(year, month),
    start,
    end: periodStart(nextYear, nextMonth, anchor),
  }
}

/** The month key of the allowance period that contains `now`. */
export function allowancePeriod(now: number, anchorDay: number): string {
  return allowancePeriodBounds(now, anchorDay).key
}

/**
 * The first millisecond of the period after the one that contains `now`.
 * The gate uses it to say when the allowance comes back.
 */
export function allowanceRefreshAt(now: number, anchorDay: number): number {
  return allowancePeriodBounds(now, anchorDay).end
}
