import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openDatabase } from '../../server/db.ts'
import type { Db } from '../../server/db.ts'
import { Settings } from '../../server/settings.ts'
import { AllowanceError, AllowanceStore } from '../../server/allowance.ts'
import { allowancePeriodBounds } from '../../shared/allowance.ts'

const firstVisit = Date.parse('2026-10-23T12:00:00.000Z')
const device = { kind: 'device' as const, id: 'device-1' }
const account = { kind: 'account' as const, id: 'account-1' }

function memoryDb(t: { after(fn: () => void): void }): Db {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  return db
}

function makeAccount(db: Db, id = account.id, anchorDay = 23): void {
  db.prepare(
    `insert into accounts (id, email, email_normalized, created_at, allowance_anchor_day)
     values (?, ?, ?, ?, ?)`,
  ).run(id, `${id}@example.com`, `${id}@example.com`, firstVisit, anchorDay)
}

function refused(code: string) {
  return (error: unknown): boolean => error instanceof AllowanceError && error.code === code
}

describe('server allowance counters', () => {
  test('a fresh device and a fresh account each hold the shipped counters', (t) => {
    const db = memoryDb(t)
    makeAccount(db)
    const store = new AllowanceStore(db, { now: () => firstVisit })

    const deviceSnapshot = store.allowance(device)
    const accountSnapshot = store.allowance(account)

    assert.equal(deviceSnapshot.period, '2026-10')
    assert.deepEqual(deviceSnapshot.remaining, { rounds: 5, revisions: 3, checks: 36 })
    assert.deepEqual(accountSnapshot.remaining, { rounds: 5, revisions: 3, checks: 36 })
    assert.equal(deviceSnapshot.plan, 'free')
    assert.equal(accountSnapshot.plan, 'free')
    assert.equal(deviceSnapshot.rounds.used, 0)
    assert.equal(deviceSnapshot.checks.limit, 36)
  })

  test('a device and an account never spend one another counters', (t) => {
    const db = memoryDb(t)
    makeAccount(db)
    const store = new AllowanceStore(db, { now: () => firstVisit })

    store.spend(device, { rounds: 2, checks: 3 })
    store.spend(account, { rounds: 1 })

    assert.deepEqual(store.allowance(device).remaining, { rounds: 3, revisions: 3, checks: 33 })
    assert.deepEqual(store.allowance(account).remaining, { rounds: 4, revisions: 3, checks: 36 })
  })

  test('the counters refresh on the first-visit day, not on the first of the month', (t) => {
    const db = memoryDb(t)
    const clock = { now: firstVisit }
    const store = new AllowanceStore(db, { now: () => clock.now })

    store.spend(device, { rounds: 3, revisions: 2, checks: 4 })

    clock.now = Date.parse('2026-11-22T12:00:00.000Z')
    assert.equal(store.allowance(device).period, '2026-10')
    assert.deepEqual(store.allowance(device).used, { rounds: 3, revisions: 2, checks: 4 })

    clock.now = Date.parse('2026-11-23T12:00:00.000Z')
    const refreshed = store.allowance(device)
    assert.equal(refreshed.period, '2026-11')
    assert.deepEqual(refreshed.used, { rounds: 0, revisions: 0, checks: 0 })
    assert.deepEqual(refreshed.remaining, { rounds: 5, revisions: 3, checks: 36 })

    // The old month is kept, not rewritten.
    const old = db
      .prepare(
        `select rounds, revisions, checks from allowance_counters
         where subject_kind = 'device' and subject_id = 'device-1' and period = '2026-10'`,
      )
      .get() as { rounds: number; revisions: number; checks: number }
    assert.deepEqual(
      { rounds: old.rounds, revisions: old.revisions, checks: old.checks },
      { rounds: 3, revisions: 2, checks: 4 },
    )
  })

  test('an account refreshes on its own first-visit day too', (t) => {
    const db = memoryDb(t)
    makeAccount(db, account.id, 23)
    const clock = { now: firstVisit }
    const store = new AllowanceStore(db, { now: () => clock.now })

    store.spend(account, { rounds: 4 })
    clock.now = Date.parse('2026-11-22T12:00:00.000Z')
    assert.equal(store.allowance(account).remaining.rounds, 1)
    clock.now = Date.parse('2026-11-23T12:00:00.000Z')
    assert.equal(store.allowance(account).remaining.rounds, 5)
  })

  test('the first-visit day is clamped to a short month', () => {
    assert.equal(allowancePeriodBounds(Date.parse('2026-01-31T12:00:00.000Z'), 31).key, '2026-01')
    assert.equal(allowancePeriodBounds(Date.parse('2026-02-28T12:00:00.000Z'), 31).key, '2026-02')
    assert.equal(allowancePeriodBounds(Date.parse('2026-03-30T12:00:00.000Z'), 31).key, '2026-02')
    assert.equal(allowancePeriodBounds(Date.parse('2026-03-31T12:00:00.000Z'), 31).key, '2026-03')
  })

  test('a cost is checked and taken in one step, and a short counter refuses the whole cost', (t) => {
    const db = memoryDb(t)
    const store = new AllowanceStore(db, { now: () => firstVisit })

    for (let i = 0; i < 5; i += 1) store.spendRound(device, 1)
    assert.equal(store.allowance(device).remaining.rounds, 0)

    assert.throws(() => store.spendRound(device, 1), refused('allowance_exhausted'))
    assert.equal(store.allowance(device).used.rounds, 5)

    // A high effort round costs more than one round and is refused whole.
    const fresh = { kind: 'device' as const, id: 'device-2' }
    assert.throws(() => store.spendRound(fresh, 6), refused('allowance_exhausted'))
    assert.equal(store.allowance(fresh).used.rounds, 0)
  })

  test('a round at a higher effort spends its multiplier from the rounds counter', (t) => {
    const db = memoryDb(t)
    const store = new AllowanceStore(db, { now: () => firstVisit })

    store.spendRound(device, 2)
    assert.equal(store.allowance(device).used.rounds, 2)
    store.spendRound(device, 3)
    assert.equal(store.allowance(device).remaining.rounds, 0)
    assert.throws(() => store.spendRound(device, 1), refused('allowance_exhausted'))
  })

  test('a multi-pair reserve covers the whole cost or nothing, and refunds unanswered pairs', (t) => {
    const db = memoryDb(t)
    const store = new AllowanceStore(db, { now: () => firstVisit })

    const ten = store.reserveChecks(device, 10)
    assert.equal(ten.status, 'held')
    assert.equal(ten.checks, 10)
    assert.equal(store.allowance(device).used.checks, 10)

    // Thirty more checks do not fit in the 36-check allowance, so nothing moves.
    assert.throws(() => store.reserveChecks(device, 30), refused('allowance_exhausted'))
    assert.equal(store.allowance(device).used.checks, 10)

    // Seven pairs answered; three give their checks back.
    const settled = store.settle(ten.id, { checks: 7 })
    assert.equal(settled.status, 'settled')
    assert.equal(settled.remainingChecks, 0)
    assert.equal(store.allowance(device).used.checks, 7)
    assert.equal(store.allowance(device).remaining.checks, 29)

    // Closing again changes nothing.
    store.settle(ten.id, { checks: 7 })
    assert.equal(store.allowance(device).used.checks, 7)
  })

  test('a failed action gets its whole cost back, and a reservation survives a new store', (t) => {
    const db = memoryDb(t)
    const clock = { now: firstVisit }
    const first = new AllowanceStore(db, { now: () => clock.now })

    const held = first.reserveChecks(device, 12, 'project-1')
    assert.equal(first.allowance(device).remaining.checks, 24)

    const reloaded = new AllowanceStore(db, { now: () => clock.now })
    const released = reloaded.release(held.id)
    assert.equal(released.status, 'released')
    assert.equal(reloaded.allowance(device).used.checks, 0)
    assert.equal(reloaded.allowance(device).remaining.checks, 36)

    // Releasing twice is harmless.
    reloaded.release(held.id)
    assert.equal(reloaded.allowance(device).used.checks, 0)
  })

  test('a setting lowered after the month started keeps the allowance already shown', (t) => {
    const db = memoryDb(t)
    const clock = { now: firstVisit }
    const settings = new Settings(db, () => new Date(clock.now))
    const store = new AllowanceStore(db, { settings, now: () => clock.now })

    store.spend(device, { checks: 1 })
    assert.equal(store.allowance(device).checks.limit, 36)

    settings.set('free.checks', 10, 'operator@example.com')
    assert.equal(store.allowance(device).checks.limit, 36)

    clock.now = Date.parse('2026-11-23T12:00:00.000Z')
    assert.equal(store.allowance(device).checks.limit, 10)
    assert.equal(store.allowance(device).remaining.checks, 10)
  })

  test('an active Pro account uses the Pro counters', (t) => {
    const db = memoryDb(t)
    makeAccount(db)
    db.prepare("update accounts set plan = 'pro', plan_active = 1 where id = ?").run(account.id)
    const store = new AllowanceStore(db, { now: () => firstVisit })

    assert.equal(store.allowance(account).plan, 'pro')
    assert.equal(store.allowance(account).rounds.limit, 60)
    assert.equal(store.allowance(account).revisions.limit, 40)
    assert.equal(store.allowance(account).checks.limit, 400)
  })

  test('a malformed cost is refused before anything is taken', (t) => {
    const db = memoryDb(t)
    const store = new AllowanceStore(db, { now: () => firstVisit })

    assert.throws(() => store.spend(device, { checks: -1 }), refused('usage_invalid'))
    assert.throws(() => store.reserveChecks(device, 1.5), refused('usage_invalid'))
    assert.equal(store.allowance(device).used.checks, 0)
  })
})
