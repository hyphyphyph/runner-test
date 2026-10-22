// The allowance (FreeAllowance, Billing, Accounts.noSecondAllowance).
// Counters belong to a subject: a device with no account, an account, or a
// Studio organization. They refresh monthly on the day of the first visit.

import type { Db } from './db.ts'
import { one, run, tx } from './db.ts'
import type { Settings } from './settings.ts'
import type { Allowance, Gate, Level, LevelInfo } from '../shared/types.ts'
import { LEVELS } from '../shared/types.ts'

export interface AccountRow {
  id: string
  email: string
  password_hash: string | null
  created_at: number
  anchor_day: number
  operator: number
  plan: string
  plan_active: number
  stripe_customer: string | null
  stripe_subscription: string | null
  credits: number
  email_prefs: string
  deleted_at: number | null
  purge_at: number | null
}

export interface OrgRow {
  id: string
  name: string
  owner_id: string
  seats: number
  plan_active: number
  stripe_subscription: string | null
  credits: number
  anchor_day: number
  created_at: number
}

export interface Actor {
  deviceId: string
  deviceAnchor: number
  ipHash: string
  account: AccountRow | null
  org: (OrgRow & { role: 'owner' | 'member' }) | null
}

export type Counter = 'rounds' | 'revisions' | 'checks'

// The period that holds `now`, starting on the anchor day of the month
// (clamped to the month's length).
export function period(now: number, anchorDay: number): { start: number; end: number; key: string } {
  const d = new Date(now)
  const startIn = (y: number, m: number) => {
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    return Date.UTC(y, m, Math.min(anchorDay, days))
  }
  let y = d.getUTCFullYear()
  let m = d.getUTCMonth()
  let start = startIn(y, m)
  if (start > now) {
    m -= 1
    if (m < 0) {
      m = 11
      y -= 1
    }
    start = startIn(y, m)
  }
  const ny = m === 11 ? y + 1 : y
  const nm = (m + 1) % 12
  const end = startIn(ny, nm)
  return { start, end, key: new Date(start).toISOString().slice(0, 10) }
}

export function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7)
}

interface Subject {
  key: string
  kind: 'device' | 'account' | 'organization'
  plan: 'free' | 'pro' | 'studio'
  anchor: number
  seats: number
}

export function subjectOf(actor: Actor): Subject {
  if (actor.account && actor.org && actor.org.plan_active) {
    return { key: 'org:' + actor.org.id, kind: 'organization', plan: 'studio', anchor: actor.org.anchor_day, seats: actor.org.seats }
  }
  if (actor.account) {
    const pro = actor.account.plan === 'pro' && actor.account.plan_active === 1
    return { key: 'account:' + actor.account.id, kind: 'account', plan: pro ? 'pro' : 'free', anchor: actor.account.anchor_day, seats: 1 }
  }
  return { key: 'device:' + actor.deviceId, kind: 'device', plan: 'free', anchor: actor.deviceAnchor, seats: 1 }
}

export function planLimits(settings: Settings, plan: Subject['plan'], seats: number): Record<Counter, number> {
  const per = plan === 'studio' ? seats : 1
  return {
    rounds: settings.num(`${plan}.rounds`) * per,
    revisions: settings.num(`${plan}.revisions`) * per,
    checks: settings.num(`${plan}.checks`) * per,
  }
}

interface UsageRow {
  rounds: number
  revisions: number
  checks: number
  limit_rounds: number | null
  limit_revisions: number | null
  limit_checks: number | null
  limit_plan: string | null
}

function usageRow(db: Db, subject: string, key: string): UsageRow {
  return (
    one<UsageRow>(db, 'select * from usage where subject = ? and period = ?', subject, key) ?? {
      rounds: 0,
      revisions: 0,
      checks: 0,
      limit_rounds: null,
      limit_revisions: null,
      limit_checks: null,
      limit_plan: null,
    }
  )
}

function ensureUsage(db: Db, subject: string, key: string, limits: Record<Counter, number>, plan: string): void {
  // The first counted action of a month records the limits shown, so a
  // later lowering by the operator does not change the month in progress.
  run(
    db,
    `insert into usage (subject, period, limit_rounds, limit_revisions, limit_checks, limit_plan)
     values (?, ?, ?, ?, ?, ?) on conflict do nothing`,
    subject,
    key,
    limits.rounds,
    limits.revisions,
    limits.checks,
    plan,
  )
}

function effectiveLimits(row: UsageRow, current: Record<Counter, number>, plan: string): Record<Counter, number> {
  if (row.limit_plan !== plan) return current
  return {
    rounds: Math.max(current.rounds, row.limit_rounds ?? 0),
    revisions: Math.max(current.revisions, row.limit_revisions ?? 0),
    checks: Math.max(current.checks, row.limit_checks ?? 0),
  }
}

function creditsOf(actor: Actor, subject: Subject): number {
  if (!actor.account) return 0
  if (subject.kind === 'organization' && actor.org) return actor.org.credits + actor.account.credits
  return actor.account.credits
}

export function allowance(db: Db, settings: Settings, actor: Actor, now = Date.now()): Allowance {
  const s = subjectOf(actor)
  const p = period(now, s.anchor)
  const row = usageRow(db, s.key, p.key)
  const limits = effectiveLimits(row, planLimits(settings, s.plan, s.seats), s.plan)
  return {
    subject: s.kind,
    plan: s.plan,
    rounds: { used: row.rounds, limit: limits.rounds },
    revisions: { used: row.revisions, limit: limits.revisions },
    checks: { used: row.checks, limit: limits.checks },
    credits: creditsOf(actor, s),
    resetsAt: p.end,
  }
}

export function levelInfo(settings: Settings, unavailable: Set<string>): LevelInfo[] {
  const cfg = settings.config()
  const batch = settings.num('round.batch')
  const sizes: Record<Level, number> = {
    quick: Math.max(5, Math.round(batch * 1.5)),
    balanced: Math.max(5, batch),
    thorough: Math.max(5, Math.round(batch * 0.6)),
  }
  const seconds: Record<Level, number> = { quick: 15, balanced: 30, thorough: 60 }
  return LEVELS.map((level) => ({
    level,
    label: cfg.levels[level].label,
    multiplier: settings.num(`level.${level}.multiplier`),
    creditCost: settings.num(`level.${level}.credits`),
    batch: sizes[level],
    expectedSeconds: seconds[level],
    available: !unavailable.has('level:' + level),
    unavailableReason: unavailable.has('level:' + level)
      ? `${cfg.levels[level].label} is not available right now. Pick another level, or try again later.`
      : null,
  }))
}

export interface Payment {
  counter: Counter
  amount: number
  credits: number
}

const WORDS: Record<Counter, string> = {
  rounds: 'generation rounds',
  revisions: 'revision rounds',
  checks: 'domain checks',
}

// Work out how a counted action would be paid, or the gate that stops it.
export function quote(
  db: Db,
  settings: Settings,
  actor: Actor,
  counter: Counter,
  amount: number,
  creditCost: number,
  now = Date.now(),
): { ok: true; payment: Payment } | { ok: false; gate: Gate } {
  const a = allowance(db, settings, actor, now)
  const left = a[counter].limit - a[counter].used
  const s = subjectOf(actor)
  if (counter === 'rounds' && s.kind === 'device') {
    const net = one<{ rounds: number }>(
      db,
      'select rounds from network_usage where ip_hash = ? and month = ?',
      actor.ipHash,
      monthKey(now),
    )
    if ((net?.rounds ?? 0) + amount > settings.num('network.ceiling')) {
      return {
        ok: false,
        gate: {
          gate: true,
          network: true,
          ranOut: 'The free use from this network is used up for this month. Sign in or subscribe to continue the work.',
          resetsAt: null,
          signedIn: false,
          canBuyCredits: false,
        },
      }
    }
  }
  if (left >= amount) return { ok: true, payment: { counter, amount, credits: 0 } }
  // Credits pay only for generation rounds, after the plan's own allowance.
  if (counter === 'rounds' && a.credits >= creditCost && creditCost > 0) {
    return { ok: true, payment: { counter, amount: 0, credits: creditCost } }
  }
  const word = WORDS[counter]
  const ranOut =
    left <= 0
      ? `You have used all ${a[counter].limit} ${word} for this month.`
      : `This needs ${amount} ${word} and you have ${left} left this month.`
  return {
    ok: false,
    gate: {
      gate: true,
      ranOut,
      resetsAt: a.resetsAt,
      signedIn: actor.account !== null,
      canBuyCredits: actor.account !== null && counter === 'rounds',
    },
  }
}

// Spend a payment after the action succeeded, never before.
export function charge(db: Db, settings: Settings, actor: Actor, payment: Payment, projectId: string | null, now = Date.now()): void {
  const s = subjectOf(actor)
  const p = period(now, s.anchor)
  tx(db, () => {
    ensureUsage(db, s.key, p.key, planLimits(settings, s.plan, s.seats), s.plan)
    if (payment.amount > 0) {
      run(db, `update usage set ${payment.counter} = ${payment.counter} + ? where subject = ? and period = ?`, payment.amount, s.key, p.key)
      if (payment.counter === 'rounds' && s.kind === 'device') {
        run(
          db,
          `insert into network_usage (ip_hash, month, rounds) values (?, ?, ?)
           on conflict(ip_hash, month) do update set rounds = rounds + excluded.rounds`,
          actor.ipHash,
          monthKey(now),
          payment.amount,
        )
      }
    }
    if (payment.credits > 0 && actor.account) {
      let due = payment.credits
      if (s.kind === 'organization' && actor.org) {
        const fromOrg = Math.min(due, actor.org.credits)
        run(db, 'update orgs set credits = credits - ? where id = ?', fromOrg, actor.org.id)
        actor.org.credits -= fromOrg
        due -= fromOrg
      }
      if (due > 0) {
        run(db, 'update accounts set credits = max(0, credits - ?) where id = ?', due, actor.account.id)
        actor.account.credits -= due
      }
    }
    if (projectId) {
      const col = { rounds: 'used_rounds', revisions: 'used_revisions', checks: 'used_checks' }[payment.counter]
      run(db, `update projects set ${col} = ${col} + ?, used_credits = used_credits + ? where id = ?`, payment.amount, payment.credits, projectId)
    }
  })
}

// At sign-in the account's used count for the month becomes the higher of
// its own and the device's, so signing in never hands out a second allowance.
// An account with a subscription is never moved down by a device.
export function mergeDeviceUsage(db: Db, deviceId: string, deviceAnchor: number, account: AccountRow, now = Date.now()): void {
  if (account.plan_active === 1) return
  const dp = period(now, deviceAnchor)
  const dev = usageRow(db, 'device:' + deviceId, dp.key)
  const ap = period(now, account.anchor_day)
  const key = 'account:' + account.id
  tx(db, () => {
    run(db, 'insert into usage (subject, period) values (?, ?) on conflict do nothing', key, ap.key)
    run(
      db,
      `update usage set rounds = max(rounds, ?), revisions = max(revisions, ?), checks = max(checks, ?)
       where subject = ? and period = ?`,
      dev.rounds,
      dev.revisions,
      dev.checks,
      key,
      ap.key,
    )
  })
}
