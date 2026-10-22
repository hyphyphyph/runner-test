// The free allowance shown in the naming workspace.
//
// The specification (Limits) says every counted limit is an operator setting,
// never a fixed number in the product. The admin settings and their API route
// are built separately, so this module holds the shipped starting values from
// Limits.defaults. The page reads them through one function, which is the
// place a later settings route plugs into without changing the view.
//
// The arithmetic lives in shared/allowance.ts because the server spends the
// same counters and must agree on what a month and a cost mean.

export {
  allowancePeriod,
  allowancePeriodBounds,
  allowanceRefreshAt,
  clampAnchorDay,
  hasRoundLeft,
  isAllowanceCounter,
  isZeroCost,
  normalizeAllowanceCost,
  remainingAllowance,
  SHIPPED_FREE_ALLOWANCE,
} from '../../shared/allowance.ts'

export type {
  AllowanceCost,
  AllowanceCounter,
  AllowanceCounts,
  AllowanceLimits,
  AllowancePeriod,
  FullAllowanceCost,
  RemainingAllowance,
} from '../../shared/allowance.ts'
