// The operator's admin interface (Admin). It sets limits and fixes people;
// it never takes payments, refunds or changes a bill. Every change is
// recorded with the old and new value, the time, the operator and a reason.

import type { Ctx } from './context.ts'
import { all, one, run, tx } from './db.ts'
import type { AccountRow, Actor, OrgRow } from './allowance.ts'
import { allowance } from './allowance.ts'
import { orgFor, requireOperator } from './auth.ts'
import { MIN_SEATS, changeSeats } from './billing.ts'
import { fail } from './http.ts'
import { detachMember } from './orgs.ts'
import { audit, auditLog } from './settings.ts'

function reasonOf(body: Record<string, unknown>): string {
  const r = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!r) fail(400, 'Give a reason for this change; it is kept in the record.')
  return r.slice(0, 500)
}

export const PARTS = ['level:quick', 'level:balanced', 'level:thorough', 'lookup', 'billing']

export function overview(ctx: Ctx, actor: Actor) {
  requireOperator(actor)
  const unavailable = all<{ part: string }>(ctx.db, 'select part from unavailable').map((r) => r.part)
  return {
    settings: ctx.settings.all(),
    config: ctx.settings.config(),
    parts: PARTS.map((p) => ({ part: p, unavailable: unavailable.includes(p) })),
    alerts: ctx.alerts.list(),
    audit: auditLog(ctx.db),
    numbers: monthNumbers(ctx),
  }
}

export function setSetting(ctx: Ctx, actor: Actor, body: Record<string, unknown>) {
  const op = requireOperator(actor)
  const reason = reasonOf(body)
  const problem =
    body.clear === true
      ? ctx.settings.resetNumber(String(body.key), op.email, reason)
      : ctx.settings.setNumber(String(body.key), body.value, op.email, reason)
  if (problem) fail(400, problem)
}

export function setConfig(ctx: Ctx, actor: Actor, body: Record<string, unknown>) {
  const op = requireOperator(actor)
  const problem = ctx.settings.setConfig(body.config, op.email, reasonOf(body))
  if (problem) fail(400, problem)
}

export function setUnavailable(ctx: Ctx, actor: Actor, body: Record<string, unknown>) {
  const op = requireOperator(actor)
  const part = String(body.part)
  if (!PARTS.includes(part)) fail(400, 'There is no such part.')
  const reason = reasonOf(body)
  if (body.unavailable === true) run(ctx.db, 'insert into unavailable (part, at, operator) values (?, ?, ?) on conflict do nothing', part, Date.now(), op.email)
  else run(ctx.db, 'delete from unavailable where part = ?', part)
  audit(ctx.db, op.email, body.unavailable ? 'marked unavailable' : 'marked available', part, null, null, reason)
}

export function dismissAlert(ctx: Ctx, actor: Actor, alertId: number) {
  const op = requireOperator(actor)
  ctx.alerts.dismiss(alertId)
  audit(ctx.db, op.email, 'alert dismissed', String(alertId), null, null, null)
}

export function alertDetail(ctx: Ctx, actor: Actor, alertId: number) {
  requireOperator(actor)
  const a = one<{ part: string }>(ctx.db, 'select part from alerts where id = ?', alertId)
  if (!a) fail(404, 'No such alert.')
  return ctx.alerts.failuresFor(a.part)
}

function personView(ctx: Ctx, a: AccountRow) {
  const org = orgFor(ctx, a.id)
  const actor: Actor = { deviceId: '-', deviceAnchor: 1, ipHash: '-', account: a, org }
  return {
    id: a.id,
    email: a.email,
    plan: a.plan,
    planActive: a.plan_active === 1,
    credits: a.credits,
    operator: a.operator === 1,
    deletedAt: a.deleted_at,
    org: org ? { id: org.id, name: org.name, role: org.role, seats: org.seats, credits: org.credits, active: org.plan_active === 1 } : null,
    members: org ? (ctx.db.prepare('select count(*) as n from org_members where org_id = ?').get(org.id) as { n: number }).n : 0,
    allowance: allowance(ctx.db, ctx.settings, actor),
  }
}

export function searchPeople(ctx: Ctx, actor: Actor, q: string) {
  requireOperator(actor)
  const term = q.trim().toLowerCase()
  if (!term) return []
  return all<AccountRow>(ctx.db, "select * from accounts where email like ? escape '\\' order by email limit 25", '%' + term.replace(/[%_\\]/g, (m) => '\\' + m) + '%').map(
    (a) => personView(ctx, a),
  )
}

function account(ctx: Ctx, accountId: string): AccountRow {
  const a = one<AccountRow>(ctx.db, 'select * from accounts where id = ?', accountId)
  if (!a) fail(404, 'No such account.')
  return a
}

function notifyCustomer(ctx: Ctx, email: string, what: string) {
  ctx.mail.queue(email, 'admin-notice', 'A change to your account', [what, 'If you did not expect this, reply to this email.'])
}

export function grantCredits(ctx: Ctx, actor: Actor, body: Record<string, unknown>) {
  const op = requireOperator(actor)
  const reason = reasonOf(body)
  const a = account(ctx, String(body.accountId))
  const n = body.credits
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) fail(400, 'Credits must be a positive whole number.')
  run(ctx.db, 'update accounts set credits = credits + ? where id = ?', n, a.id)
  audit(ctx.db, op.email, 'credits granted', a.email, String(a.credits), String(a.credits + n), reason)
  notifyCustomer(ctx, a.email, `${n} credits were added to your account by the NameTempest operator.`)
}

export function setPlan(ctx: Ctx, actor: Actor, body: Record<string, unknown>) {
  const op = requireOperator(actor)
  const reason = reasonOf(body)
  const a = account(ctx, String(body.accountId))
  const plan = body.plan
  if (plan !== 'free' && plan !== 'pro') fail(400, 'Choose free or Pro. Studio is set through an organization.')
  const old = `${a.plan}${a.plan_active ? '' : ' (inactive)'}`
  run(ctx.db, 'update accounts set plan = ?, plan_active = ? where id = ?', plan, plan === 'pro' ? 1 : 0, a.id)
  audit(ctx.db, op.email, 'plan changed', a.email, old, plan, reason)
  notifyCustomer(ctx, a.email, `Your plan was changed to ${plan === 'pro' ? 'Pro' : 'the free allowance'} by the NameTempest operator.`)
}

export function removeFromOrg(ctx: Ctx, actor: Actor, body: Record<string, unknown>) {
  const op = requireOperator(actor)
  const reason = reasonOf(body)
  const a = account(ctx, String(body.accountId))
  const org = orgFor(ctx, a.id)
  if (!org) fail(400, 'This person is not in an organization.')
  detachMember(ctx, org, a, 'removed')
  audit(ctx.db, op.email, 'removed from organization', a.email, org.name, null, reason)
}

export async function setOrgSeats(ctx: Ctx, actor: Actor, body: Record<string, unknown>) {
  const op = requireOperator(actor)
  const reason = reasonOf(body)
  const org = one<OrgRow>(ctx.db, 'select * from orgs where id = ?', String(body.orgId))
  if (!org) fail(404, 'No such organization.')
  const seats = body.seats
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1) fail(400, 'Seats must be a positive whole number.')
  const members = (ctx.db.prepare('select count(*) as n from org_members where org_id = ?').get(org.id) as { n: number }).n
  if (seats < members) fail(400, `This organization has ${members} members, so it cannot have fewer seats.`)
  if (seats < MIN_SEATS) fail(400, `A studio needs at least ${MIN_SEATS} seats.`)
  await changeSeats(ctx, org, seats)
  audit(ctx.db, op.email, 'seats changed', org.name, String(org.seats), String(seats), reason)
  const owner = one<AccountRow>(ctx.db, 'select * from accounts where id = ?', org.owner_id)
  if (owner) notifyCustomer(ctx, owner.email, `The seats of "${org.name}" were changed from ${org.seats} to ${seats} by the NameTempest operator.`)
}

// The three first-month numbers (MonthGoals), counted from the product's own
// records. They are shown to the operator only and change nothing a person
// sees.
export function monthNumbers(ctx: Ctx) {
  const n = (sql: string, ...p: unknown[]) => (ctx.db.prepare(sql).get(...(p as never[])) as { n: number }).n
  const proAccounts = n("select count(*) as n from accounts where plan = 'pro' and plan_active = 1")
  const studios = n('select count(*) as n from orgs where plan_active = 1')
  const seats = n('select coalesce(sum(seats), 0) as n from orgs where plan_active = 1')
  const usedFree = n("select count(distinct subject) as n from usage where rounds > 0 and subject like 'account:%'")
  const paidAfterFree = n(
    "select count(*) as n from accounts a where (a.plan_active = 1 or exists (select 1 from org_members m join orgs o on o.id = m.org_id where m.account_id = a.id and m.role = 'owner' and o.plan_active = 1)) and exists (select 1 from usage u where u.subject = 'account:' || a.id)",
  )
  const kept = all<{ k: number }>(ctx.db, "select count(*) as k from candidates where status = 'kept' group by project_id order by k")
  const median = kept.length ? kept[Math.floor(kept.length / 2)].k : 0
  return {
    payingPro: proAccounts,
    payingStudios: studios,
    studioSeats: seats,
    conversion: usedFree ? Math.round((paidAfterFree / usedFree) * 1000) / 10 : 0,
    medianShortlist: median,
  }
}

export function grantOperatorByHand(ctx: Ctx, email: string, on: boolean): boolean {
  return tx(ctx.db, () => {
    const changed = run(ctx.db, 'update accounts set operator = ? where email = ?', on ? 1 : 0, email.toLowerCase())
    if (changed) audit(ctx.db, 'database', on ? 'operator granted' : 'operator removed', email, null, null, 'by hand')
    return changed > 0
  })
}
