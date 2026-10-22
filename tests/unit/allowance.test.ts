import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  hasRoundLeft,
  remainingAllowance,
  SHIPPED_FREE_ALLOWANCE,
} from '../../src/local/allowance.ts'

describe('remaining free allowance', () => {
  test('a fresh browser holds the shipped free allowance', () => {
    assert.deepEqual(
      remainingAllowance({ rounds: 0, revisions: 0, checks: 0 }),
      {
        rounds: 5,
        revisions: 3,
        checks: 36,
        limits: { rounds: 5, revisions: 3, checks: 36 },
      },
    )
    assert.equal(SHIPPED_FREE_ALLOWANCE.rounds, 5)
    assert.equal(SHIPPED_FREE_ALLOWANCE.revisions, 3)
    assert.equal(SHIPPED_FREE_ALLOWANCE.checks, 36)
  })

  test('spent counters lower the remaining counts', () => {
    const remaining = remainingAllowance({ rounds: 3, revisions: 1, checks: 12 })
    assert.equal(remaining.rounds, 2)
    assert.equal(remaining.revisions, 2)
    assert.equal(remaining.checks, 24)
  })

  test('a counter past its limit reads as zero, never as a negative', () => {
    const remaining = remainingAllowance({ rounds: 9, revisions: 4, checks: 40 })
    assert.equal(remaining.rounds, 0)
    assert.equal(remaining.revisions, 0)
    assert.equal(remaining.checks, 0)
    assert.equal(hasRoundLeft(remaining), false)
  })

  test('a round at a higher effort costs more of the remaining rounds', () => {
    const remaining = remainingAllowance({ rounds: 3, revisions: 0, checks: 0 })
    assert.equal(hasRoundLeft(remaining, 1), true)
    assert.equal(hasRoundLeft(remaining, 2), true)
    assert.equal(hasRoundLeft(remaining, 3), false)
  })

  test('the limits are copied, so a caller cannot change the shipped values', () => {
    const remaining = remainingAllowance({ rounds: 0, revisions: 0, checks: 0 })
    remaining.limits.rounds = 99
    assert.equal(SHIPPED_FREE_ALLOWANCE.rounds, 5)
  })
})
