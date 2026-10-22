// Allowance counters for a device, an account or an organization.
//
// FreeAllowance.spend says a counted action is checked against its counter
// and the cost taken in one step. This module does that in a SQLite
// `begin immediate` transaction: two callers, on one process or on two, take
// turns, so neither can spend the same remainder.
//
// A multi-pair check reserves the whole cost in the same transaction. The
// reservation is a row, so a restart does not lose a cost that was taken but
// not yet answered. Settling the answered pairs gives the rest back, and
// releasing a failed action gives all of it back.
//
// The period is the month that began on the first-visit day, clamped to the
// length of a shorter month. A new period is simply a new counter row, so an
// old month is never rewritten.

import type { Db } from './db.ts'
import { randomUUID } from 'node:crypto'
import { Settings } from './settings.ts'
import {
  allowancePeriodBounds,
  clampAnchorDay,
  normalizeAllowanceCost,
  remainingAllowance,
  type AllowanceCost,
  type AllowanceCounter,
  type AllowanceCounts,
  type AllowancePeriod,
  type FullAllowanceCost,
} from '../shared/allowance.ts'

export type AllowanceSubjectKind = 'device' | 'account' | 'organization'

/** The counters one person or place spends. */
export interface AllowanceSubject {
  kind: AllowanceSubjectKind
  id: string
}

/** One counter's used, limit and remaining values. */
export interface CounterState {
  used: number
  limit: number
  remaining: number
}

/** Everything the page needs to show and gate on the allowance. */
export interface AllowanceSnapshot {
  subjectKind: AllowanceSubjectKind
  subjectId: string
  plan: 'free' | 'pro' | 'studio'
  period: string
  anchorDay: number
  /** First millisecond of the next period. */
  refreshAt: number
  used: AllowanceCounts
  limits: AllowanceCounts
  remaining: AllowanceCounts
  /** The same three counters in a shape convenient for a gate message. */
  rounds: CounterState
  revisions: CounterState
  checks: CounterState
}

/** A whole cost taken before an action runs, and the part not yet used. */
export interface AllowanceReservation {
  id: string
  subjectKind: AllowanceSubjectKind
  subjectId: string
  period: string
  cost: FullAllowanceCost
  remaining: FullAllowanceCost
  /** Flat copies of the same amounts, for callers that read them directly. */
  rounds: number
  revisions: number
  checks: number
  remainingRounds: number
  remainingRevisions: number
  remainingChecks: number
  status: 'held' | 'settled' | 'released'
  projectId: string | null
  createdAt: number
  updatedAt: number
}

export type AllowanceErrorCode =
  | 'allowance_exhausted'
  | 'reservation_not_found'
  | 'usage_invalid'
  | 'subject_invalid'

/** A refused spend or reservation. Nothing was taken. */
export class AllowanceError extends Error {
  readonly code: AllowanceErrorCode
  readonly counter: AllowanceCounter | null
  readonly needed: number | null
  readonly remaining: number | null

  constructor(
    code: AllowanceErrorCode,
    message: string,
    details: { counter?: AllowanceCounter; needed?: number; remaining?: number } = {},
  ) {
    super(message)
    this.name = 'AllowanceError'
    this.code = code
    this.counter = details.counter ?? null
    this.needed = details.needed ?? null
    this.remaining = details.remaining ?? null
  }
}

export interface AllowanceStoreOptions {
  /** The same settings store the rest of the server uses. */
  settings?: Settings
  /** Injectable clock, so a test can cross an allowance month. */
  now?: () => number
}

interface ResolvedSubject {
  kind: AllowanceSubjectKind
  id: string
  plan: 'free' | 'pro' | 'studio'
  anchorDay: number
  seats: number
  limits: AllowanceCounts
  period: AllowancePeriod
}

interface CounterRow {
  rounds: number
  revisions: number
  checks: number
  plan: string | null
  limit_rounds: number | null
  limit_revisions: number | null
  limit_checks: number | null
}

interface ReservationRow {
  id: string
  subject_kind: AllowanceSubjectKind
  subject_id: string
  period: string
  rounds: number
  revisions: number
  checks: number
  remaining_rounds: number
  remaining_revisions: number
  remaining_checks: number
  status: 'held' | 'settled' | 'released'
  project_id: string | null
  created_at: number
  updated_at: number
}

const COUNTERS: readonly AllowanceCounter[] = ['rounds', 'revisions', 'checks']

const WORDS: Record<AllowanceCounter, string> = {
  rounds: 'generation rounds',
  revisions: 'revision rounds',
  checks: 'domain checks',
}

function zeroCost(): FullAllowanceCost {
  return { rounds: 0, revisions: 0, checks: 0 }
}

function costOf(cost: AllowanceCost): FullAllowanceCost {
  try {
    return normalizeAllowanceCost(cost)
  } catch (error) {
    throw new AllowanceError(
      'usage_invalid',
      error instanceof Error ? error.message : 'An allowance cost must be a whole number of zero or more.',
    )
  }
}

function hasCost(cost: FullAllowanceCost): boolean {
  return cost.rounds > 0 || cost.revisions > 0 || cost.checks > 0
}

function today(now: number): number {
  return clampAnchorDay(new Date(now).getUTCDate())
}

function mapReservation(row: ReservationRow): AllowanceReservation {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    period: row.period,
    cost: { rounds: row.rounds, revisions: row.revisions, checks: row.checks },
    remaining: {
      rounds: row.remaining_rounds,
      revisions: row.remaining_revisions,
      checks: row.remaining_checks,
    },
    rounds: row.rounds,
    revisions: row.revisions,
    checks: row.checks,
    remainingRounds: row.remaining_rounds,
    remainingRevisions: row.remaining_revisions,
    remainingChecks: row.remaining_checks,
    status: row.status,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Run `action` while holding SQLite's write lock. The lock is what makes the
 * read, check and update one step across connections and processes. A caller
 * that already opened a transaction keeps it.
 */
function withImmediate<T>(db: Db, action: () => T): T {
  const holder = db as Db & { isTransaction?: boolean }
  if (holder.isTransaction === true) return action()

  db.exec('begin immediate')
  try {
    const result = action()
    db.exec('commit')
    return result
  } catch (error) {
    try {
      db.exec('rollback')
    } catch {
      // The rollback failed too; the original error is the useful one.
    }
    throw error
  }
}

/**
 * The allowance counters. One store can be shared by every route; the open
 * database and the settings store are the only state it holds.
 */
export class AllowanceStore {
  readonly #db: Db
  readonly #settings: Settings
  readonly #now: () => number

  constructor(db: Db, options: AllowanceStoreOptions = {}) {
    this.#db = db
    this.#settings = options.settings ?? new Settings(db)
    this.#now = options.now ?? Date.now
  }

  /** The counters right now, after any monthly refresh. */
  allowance(subject: AllowanceSubject): AllowanceSnapshot {
    const now = this.#now()
    const resolved = this.#resolve(subject, now)
    return this.#snapshot(resolved)
  }

  /** A second name for `allowance`, used by callers that prefer `snapshot`. */
  snapshot(subject: AllowanceSubject): AllowanceSnapshot {
    return this.allowance(subject)
  }

  /** Only the remaining counts, for a small gate or a top-bar slot. */
  remaining(subject: AllowanceSubject): AllowanceCounts {
    return this.allowance(subject).remaining
  }

  /**
   * Check a whole cost and take it in one step. Returns the counters after
   * the spend. When any counter is short, throws
   * AllowanceError('allowance_exhausted') and takes nothing.
   */
  spend(subject: AllowanceSubject, cost: AllowanceCost): AllowanceSnapshot {
    const amount = costOf(cost)
    if (!hasCost(amount)) return this.allowance(subject)

    return withImmediate(this.#db, () => {
      const now = this.#now()
      const resolved = this.#resolve(subject, now)
      this.#take(resolved, amount, now)
      return this.#snapshot(resolved)
    })
  }

  /** Spend one named counter, such as a revision round or one check. */
  spendCounter(subject: AllowanceSubject, counter: AllowanceCounter, amount = 1): AllowanceSnapshot {
    return this.spend(subject, { [counter]: amount })
  }

  /** Spend generation rounds at an effort level's multiplier. */
  spendRound(subject: AllowanceSubject, multiplier = 1): AllowanceSnapshot {
    return this.spendCounter(subject, 'rounds', multiplier)
  }

  /** Spend one revision round. */
  spendRevision(subject: AllowanceSubject): AllowanceSnapshot {
    return this.spendCounter(subject, 'revisions', 1)
  }

  /** Spend domain checks, one per answered name and ending pair. */
  spendChecks(subject: AllowanceSubject, amount = 1): AllowanceSnapshot {
    return this.spendCounter(subject, 'checks', amount)
  }

  /**
   * Take a whole cost now and hold it for a multi-pair action. Either every
   * counter fits and the whole cost is taken, or the call throws and nothing
   * is taken.
   */
  reserve(
    subject: AllowanceSubject,
    cost: AllowanceCost,
    projectId: string | null = null,
  ): AllowanceReservation {
    const amount = costOf(cost)

    return withImmediate(this.#db, () => {
      const now = this.#now()
      const resolved = this.#resolve(subject, now)
      this.#take(resolved, amount, now)

      const row: ReservationRow = {
        id: randomUUID(),
        subject_kind: resolved.kind,
        subject_id: resolved.id,
        period: resolved.period.key,
        rounds: amount.rounds,
        revisions: amount.revisions,
        checks: amount.checks,
        remaining_rounds: amount.rounds,
        remaining_revisions: amount.revisions,
        remaining_checks: amount.checks,
        status: 'held',
        project_id: projectId,
        created_at: now,
        updated_at: now,
      }
      this.#insertReservation(row)
      return mapReservation(row)
    })
  }

  /** Reserve one check for every ticked name and ending pair. */
  reserveChecks(
    subject: AllowanceSubject,
    pairs: number,
    projectId: string | null = null,
  ): AllowanceReservation {
    return this.reserve(subject, { checks: pairs }, projectId)
  }

  /**
   * Close a held reservation. `used` is what the action actually answered;
   * the rest returns to the counter. With no `used`, the whole reservation is
   * spent. Closing an already closed reservation changes nothing.
   */
  settle(reservationId: string, used?: AllowanceCost): AllowanceReservation {
    return this.#close(reservationId, used, 'settled')
  }

  /** Give a failed or stopped action's whole cost back. */
  release(reservationId: string): AllowanceReservation {
    return this.#close(reservationId, zeroCost(), 'released')
  }

  /** Close a reservation after a number of answered pairs. */
  settleChecks(reservationId: string, answered: number): AllowanceReservation {
    return this.settle(reservationId, { checks: answered })
  }

  /** Another name for `settle`, matching the word used in the requirement. */
  settleReservation(reservationId: string, used?: AllowanceCost): AllowanceReservation {
    return this.settle(reservationId, used)
  }

  /** Another name for `release`, matching the word used in the requirement. */
  releaseReservation(reservationId: string): AllowanceReservation {
    return this.release(reservationId)
  }

  /** Every reservation still holding a cost for one subject. */
  heldReservations(subject: AllowanceSubject): AllowanceReservation[] {
    const rows = this.#db
      .prepare(
        `select * from allowance_reservations
         where subject_kind = ? and subject_id = ? and status = 'held'
         order by created_at, id`,
      )
      .all(subject.kind, subject.id) as unknown as ReservationRow[]
    return rows.map(mapReservation)
  }

  // ---- internals --------------------------------------------------------

  #resolve(subject: AllowanceSubject, now: number): ResolvedSubject {
    if (subject.kind !== 'device' && subject.kind !== 'account' && subject.kind !== 'organization') {
      throw new AllowanceError('subject_invalid', 'An allowance belongs to a device, an account or an organization.')
    }
    if (typeof subject.id !== 'string' || subject.id.trim().length === 0) {
      throw new AllowanceError('subject_invalid', 'An allowance subject needs a non-empty id.')
    }

    let anchorDay = today(now)
    let plan: ResolvedSubject['plan'] = 'free'
    let seats = 1

    if (subject.kind === 'device') {
      const row = this.#db
        .prepare('select allowance_anchor_day from devices where id = ?')
        .get(subject.id) as { allowance_anchor_day: number } | undefined
      if (row === undefined) {
        // The first visit fixes the day the counters refresh each month.
        // `or ignore` keeps two first callers from fighting over that row.
        this.#db
          .prepare('insert or ignore into devices (id, created_at, allowance_anchor_day) values (?, ?, ?)')
          .run(subject.id, now, today(now))
        const saved = this.#db
          .prepare('select allowance_anchor_day from devices where id = ?')
          .get(subject.id) as { allowance_anchor_day: number } | undefined
        anchorDay = clampAnchorDay(saved?.allowance_anchor_day ?? today(now))
      } else {
        anchorDay = clampAnchorDay(row.allowance_anchor_day)
      }
    } else if (subject.kind === 'account') {
      const row = this.#db
        .prepare('select allowance_anchor_day, plan, plan_active from accounts where id = ?')
        .get(subject.id) as
        | { allowance_anchor_day: number; plan: 'free' | 'pro' | 'studio'; plan_active: number }
        | undefined
      if (row !== undefined) {
        anchorDay = clampAnchorDay(row.allowance_anchor_day)
        plan = row.plan === 'pro' && row.plan_active === 1 ? 'pro' : 'free'
      }
    } else {
      const row = this.#db
        .prepare('select allowance_anchor_day, plan, plan_active, seats from organizations where id = ?')
        .get(subject.id) as
        | {
            allowance_anchor_day: number
            plan: 'free' | 'pro' | 'studio'
            plan_active: number
            seats: number
          }
        | undefined
      if (row !== undefined) {
        anchorDay = clampAnchorDay(row.allowance_anchor_day)
        plan = row.plan === 'studio' && row.plan_active === 1 ? 'studio' : 'free'
        seats = Math.max(1, row.seats)
      } else {
        plan = 'studio'
      }
    }

    return {
      kind: subject.kind,
      id: subject.id,
      plan,
      anchorDay,
      seats,
      limits: this.#limits(plan, seats),
      period: allowancePeriodBounds(now, anchorDay),
    }
  }

  #limits(plan: ResolvedSubject['plan'], seats: number): AllowanceCounts {
    const per = plan === 'studio' ? Math.max(1, seats) : 1
    return {
      rounds: this.#settings.get(`${plan}.rounds`) * per,
      revisions: this.#settings.get(`${plan}.revisions`) * per,
      checks: this.#settings.get(`${plan}.checks`) * per,
    }
  }

  #snapshot(resolved: ResolvedSubject): AllowanceSnapshot {
    const row = this.#readCounters(resolved)
    const limits = this.#effectiveLimits(row, resolved)
    const used: AllowanceCounts = row === null
      ? { rounds: 0, revisions: 0, checks: 0 }
      : { rounds: row.rounds, revisions: row.revisions, checks: row.checks }
    const remaining = remainingAllowance(used, limits)

    return {
      subjectKind: resolved.kind,
      subjectId: resolved.id,
      plan: resolved.plan,
      period: resolved.period.key,
      anchorDay: resolved.anchorDay,
      refreshAt: resolved.period.end,
      used: { ...used },
      limits: { ...limits },
      remaining: {
        rounds: remaining.rounds,
        revisions: remaining.revisions,
        checks: remaining.checks,
      },
      rounds: { used: used.rounds, limit: limits.rounds, remaining: remaining.rounds },
      revisions: { used: used.revisions, limit: limits.revisions, remaining: remaining.revisions },
      checks: { used: used.checks, limit: limits.checks, remaining: remaining.checks },
    }
  }

  #readCounters(resolved: ResolvedSubject): CounterRow | null {
    return (
      (this.#db
        .prepare(
          `select rounds, revisions, checks, plan,
                  limit_rounds, limit_revisions, limit_checks
           from allowance_counters
           where subject_kind = ? and subject_id = ? and period = ?`,
        )
        .get(resolved.kind, resolved.id, resolved.period.key) as CounterRow | undefined) ?? null
    )
  }

  /**
   * A period keeps the limits it first counted with. Raising a setting may
   * apply at once; lowering it waits for the next period, so an allowance a
   * person already saw is not taken away mid-month.
   */
  #effectiveLimits(row: CounterRow | null, resolved: ResolvedSubject): AllowanceCounts {
    if (row === null || row.plan !== resolved.plan) return resolved.limits
    return {
      rounds: Math.max(resolved.limits.rounds, row.limit_rounds ?? 0),
      revisions: Math.max(resolved.limits.revisions, row.limit_revisions ?? 0),
      checks: Math.max(resolved.limits.checks, row.limit_checks ?? 0),
    }
  }

  #ensureCounters(resolved: ResolvedSubject, now: number): CounterRow {
    this.#db
      .prepare(
        `insert into allowance_counters
           (subject_kind, subject_id, period, rounds, revisions, checks, updated_at,
            plan, limit_rounds, limit_revisions, limit_checks)
         values (?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
         on conflict(subject_kind, subject_id, period) do update set
           plan = coalesce(allowance_counters.plan, excluded.plan),
           limit_rounds = coalesce(allowance_counters.limit_rounds, excluded.limit_rounds),
           limit_revisions = coalesce(allowance_counters.limit_revisions, excluded.limit_revisions),
           limit_checks = coalesce(allowance_counters.limit_checks, excluded.limit_checks)`,
      )
      .run(
        resolved.kind,
        resolved.id,
        resolved.period.key,
        now,
        resolved.plan,
        resolved.limits.rounds,
        resolved.limits.revisions,
        resolved.limits.checks,
      )

    const row = this.#readCounters(resolved)
    if (row === null) throw new Error('The allowance counters could not be read after they were created.')
    return row
  }

  #take(resolved: ResolvedSubject, amount: FullAllowanceCost, now: number): void {
    this.#ensureCounters(resolved, now)
    const row = this.#readCounters(resolved)
    if (row === null) throw new Error('The allowance counters could not be read after they were created.')
    const limits = this.#effectiveLimits(row, resolved)
    const used: AllowanceCounts = { rounds: row.rounds, revisions: row.revisions, checks: row.checks }

    const short = COUNTERS.filter((counter) => amount[counter] > Math.max(0, limits[counter] - used[counter]))
    if (short.length > 0) {
      const counter = short[0] ?? 'rounds'
      const remaining = Math.max(0, limits[counter] - used[counter])
      const message =
        short.length === 1
          ? `This action needs ${amount[counter]} ${WORDS[counter]} and ${remaining} remain this month.`
          : `This action needs more than remains this month: ${short
              .map((name) => `${amount[name]} ${WORDS[name]} of ${Math.max(0, limits[name] - used[name])}`)
              .join(', ')}.`
      throw new AllowanceError('allowance_exhausted', message, {
        counter,
        needed: amount[counter],
        remaining,
      })
    }

    this.#db
      .prepare(
        `update allowance_counters
         set rounds = rounds + ?, revisions = revisions + ?, checks = checks + ?, updated_at = ?
         where subject_kind = ? and subject_id = ? and period = ?`,
      )
      .run(
        amount.rounds,
        amount.revisions,
        amount.checks,
        now,
        resolved.kind,
        resolved.id,
        resolved.period.key,
      )
  }

  #insertReservation(row: ReservationRow): void {
    this.#db
      .prepare(
        `insert into allowance_reservations
           (id, subject_kind, subject_id, period, rounds, revisions, checks,
            remaining_rounds, remaining_revisions, remaining_checks, status,
            project_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.subject_kind,
        row.subject_id,
        row.period,
        row.rounds,
        row.revisions,
        row.checks,
        row.remaining_rounds,
        row.remaining_revisions,
        row.remaining_checks,
        row.status,
        row.project_id,
        row.created_at,
        row.updated_at,
      )
  }

  #close(
    reservationId: string,
    used: AllowanceCost | undefined,
    status: 'settled' | 'released',
  ): AllowanceReservation {
    return withImmediate(this.#db, () => {
      const row = this.#db
        .prepare('select * from allowance_reservations where id = ?')
        .get(reservationId) as ReservationRow | undefined
      if (row === undefined) {
        throw new AllowanceError('reservation_not_found', 'That held allowance was not found.')
      }
      // Closing twice is harmless: the first close already gave back the rest.
      if (row.status !== 'held') return mapReservation(row)

      const reserved: FullAllowanceCost = { rounds: row.rounds, revisions: row.revisions, checks: row.checks }
      const spending = used === undefined ? reserved : costOf(used)
      for (const counter of COUNTERS) {
        if (spending[counter] > reserved[counter]) {
          throw new AllowanceError(
            'usage_invalid',
            `The used ${WORDS[counter]} cannot be more than the ${reserved[counter]} that were reserved.`,
          )
        }
      }

      const refund: FullAllowanceCost = {
        rounds: reserved.rounds - spending.rounds,
        revisions: reserved.revisions - spending.revisions,
        checks: reserved.checks - spending.checks,
      }

      if (hasCost(refund)) {
        this.#db
          .prepare(
            `update allowance_counters
             set rounds = max(0, rounds - ?),
                 revisions = max(0, revisions - ?),
                 checks = max(0, checks - ?),
                 updated_at = ?
             where subject_kind = ? and subject_id = ? and period = ?`,
          )
          .run(
            refund.rounds,
            refund.revisions,
            refund.checks,
            this.#now(),
            row.subject_kind,
            row.subject_id,
            row.period,
          )
      }

      const now = this.#now()
      this.#db
        .prepare(
          `update allowance_reservations
           set remaining_rounds = 0, remaining_revisions = 0, remaining_checks = 0,
               status = ?, updated_at = ?
           where id = ?`,
        )
        .run(status, now, reservationId)

      row.remaining_rounds = 0
      row.remaining_revisions = 0
      row.remaining_checks = 0
      row.status = status
      row.updated_at = now
      return mapReservation(row)
    })
  }
}

/** Make a store with the same open database the rest of the server uses. */
export function createAllowanceStore(db: Db, options: AllowanceStoreOptions = {}): AllowanceStore {
  return new AllowanceStore(db, options)
}

/** A short name for the same class. */
export { AllowanceStore as Allowances }
