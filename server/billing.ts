// Billing (Billing, Plans). Stripe holds the card and takes the payment; the
// application sees only whether a subscription is active, its plan and its
// seats. Plans and credits change only from Stripe's confirmation, never
// from the browser.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Ctx } from './context.ts'
import { id, one, run, tx } from './db.ts'
import type { AccountRow, Actor, OrgRow } from './allowance.ts'
import { requireAccount } from './auth.ts'
import { fail } from './http.ts'
import { createOrg } from './orgs.ts'

export const MIN_SEATS = 3

function money(ctx: Ctx, cents: number): string {
  return `${(cents / 100).toFixed(2)} ${ctx.settings.config().currency.toUpperCase()}`
}

export function plans(ctx: Ctx) {
  const s = ctx.settings
  return {
    currency: s.config().currency,
    pro: {
      price: s.num('price.pro'),
      period: 'month',
      includes: [
        `${s.num('pro.rounds')} generation rounds, ${s.num('pro.revisions')} revision rounds and ${s.num('pro.checks')} domain checks a month`,
        'Every feature one person uses, on every device you sign in on',
      ],
    },
    studio: {
      pricePerSeat: s.num('price.studioSeat'),
      minSeats: MIN_SEATS,
      period: 'month',
      includes: [
        'Everything in Pro, for every seat',
        `${s.num('studio.rounds')} generation rounds, ${s.num('studio.revisions')} revision rounds and ${s.num('studio.checks')} domain checks a month per seat, shared by the studio`,
        'One owner pays for every seat and adds or removes members',
        'Projects shared across the organization, edited together live',
        'A per-seat volume discount on the Pro price',
      ],
    },
    credits: {
      packSize: s.num('credits.packSize'),
      packPrice: s.num('credits.packPrice'),
      meaning: 'One credit buys one round at Balanced. Credits never expire and are spent only after your monthly allowance.',
    },
  }
}

async function stripe(ctx: Ctx, method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, string | number> = {}): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) fail(503, 'Payments are not set up yet. Nothing was charged.', { retry: false })
  const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
  let res: Response
  try {
    res = await fetch(`https://api.stripe.com${path}${method === 'GET' && body.size ? '?' + body : ''}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    ctx.alerts.failed('billing', path, null, 'Stripe unreachable', String(e))
    fail(502, 'The payment provider did not answer. Your plan has not changed and nothing was charged. Try again.', { retry: true })
  }
  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok) {
    ctx.alerts.failed('billing', path, null, 'Stripe refused a request', `HTTP ${res.status} ${json?.error?.type ?? ''}`)
    fail(502, 'The payment provider could not start this payment. Your plan has not changed and nothing was charged. Try again.', {
      retry: true,
    })
  }
  ctx.alerts.succeeded('billing', null)
  return json
}

export interface Purchase {
  kind: 'pro' | 'studio' | 'credits'
  account: string
  seats?: number
  orgName?: string
  credits?: number
  org?: string
}

function purchaseFrom(ctx: Ctx, actor: Actor, body: Record<string, unknown>): Purchase {
  const a = requireAccount(actor)
  const kind = body.kind
  if (kind === 'pro') {
    if (actor.org) fail(400, 'You are in a Studio organization, which already includes everything in Pro.')
    return { kind, account: a.id }
  }
  if (kind === 'studio') {
    if (actor.org) fail(400, 'You are already in a Studio organization.')
    const seats = Number(body.seats)
    if (!Number.isInteger(seats) || seats < MIN_SEATS) fail(400, `Studio needs at least ${MIN_SEATS} seats.`)
    if (seats > 500) fail(400, 'For more than 500 seats, please write to us.')
    const orgName = typeof body.orgName === 'string' ? body.orgName.trim().slice(0, 120) : ''
    if (!orgName) fail(400, 'Give your studio a name.')
    return { kind, account: a.id, seats, orgName }
  }
  if (kind === 'credits') {
    const packs = Number(body.packs ?? 1)
    if (!Number.isInteger(packs) || packs < 1 || packs > 50) fail(400, 'Choose between 1 and 50 packs.')
    return {
      kind,
      account: a.id,
      credits: packs * ctx.settings.num('credits.packSize'),
      seats: packs,
      org: actor.org?.role === 'owner' ? actor.org.id : undefined,
    }
  }
  fail(400, 'Choose Pro, Studio or a credit pack.')
}

export async function startCheckout(ctx: Ctx, actor: Actor, body: Record<string, unknown>): Promise<{ url: string } | { done: true }> {
  const p = purchaseFrom(ctx, actor, body)
  const a = actor.account!
  if (ctx.billingMode === 'fake') {
    applyPurchase(ctx, p, { customer: 'cus_fake_' + a.id, subscription: p.kind === 'credits' ? null : 'sub_fake_' + id(), ref: id('fake_') })
    return { done: true }
  }
  if (ctx.billingMode === 'off') fail(503, 'Payments are not set up yet. Nothing was charged.', { retry: false })
  const s = ctx.settings
  const currency = s.config().currency
  const meta: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(p)) if (v !== undefined) meta[`metadata[${k}]`] = v as string | number
  const params: Record<string, string | number> = {
    success_url: `${ctx.baseUrl}/#/account?paid=1`,
    cancel_url: `${ctx.baseUrl}/#/plans`,
    client_reference_id: a.id,
    'line_items[0][price_data][currency]': currency,
    ...meta,
  }
  if (a.stripe_customer) params.customer = a.stripe_customer
  else params.customer_email = a.email
  if (p.kind === 'credits') {
    Object.assign(params, {
      mode: 'payment',
      'line_items[0][price_data][unit_amount]': s.num('credits.packPrice'),
      'line_items[0][price_data][product_data][name]': `NameTempest credits (${s.num('credits.packSize')} per pack)`,
      'line_items[0][quantity]': p.seats!,
    })
    if (!a.stripe_customer) params.customer_creation = 'always'
  } else {
    const sub: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(p)) if (v !== undefined) sub[`subscription_data[metadata][${k}]`] = v as string | number
    Object.assign(params, sub, {
      mode: 'subscription',
      'line_items[0][price_data][unit_amount]': p.kind === 'pro' ? s.num('price.pro') : s.num('price.studioSeat'),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': p.kind === 'pro' ? 'NameTempest Pro' : 'NameTempest Studio seat',
      'line_items[0][quantity]': p.kind === 'pro' ? 1 : p.seats!,
    })
  }
  const session = await stripe(ctx, 'POST', '/v1/checkout/sessions', params)
  return { url: session.url }
}

export async function portal(ctx: Ctx, actor: Actor): Promise<{ url: string }> {
  const a = requireAccount(actor)
  if (!a.stripe_customer || ctx.billingMode !== 'stripe') fail(400, 'There is no subscription to manage on this account.')
  const s = await stripe(ctx, 'POST', '/v1/billing_portal/sessions', { customer: a.stripe_customer, return_url: `${ctx.baseUrl}/#/account` })
  return { url: s.url }
}

// The confirmed result of a payment. Idempotent per payment reference.
export function applyPurchase(ctx: Ctx, p: Purchase, refs: { customer: string | null; subscription: string | null; ref: string; amount?: number }): void {
  const acc = one<AccountRow>(ctx.db, 'select * from accounts where id = ?', p.account)
  if (!acc) return
  const fresh = tx(ctx.db, () => {
    if (one(ctx.db, 'select id from payments where id = ?', refs.ref)) return false
    run(ctx.db, 'insert into payments (id, account_id, kind, amount, created_at) values (?, ?, ?, ?, ?)', refs.ref, acc.id, p.kind, refs.amount ?? null, Date.now())
    if (refs.customer) run(ctx.db, 'update accounts set stripe_customer = ? where id = ?', refs.customer, acc.id)
    if (p.kind === 'pro') {
      run(ctx.db, "update accounts set plan = 'pro', plan_active = 1, stripe_subscription = ? where id = ?", refs.subscription, acc.id)
    } else if (p.kind === 'studio') {
      createOrg(ctx, acc, p.orgName ?? 'Studio', p.seats ?? MIN_SEATS, refs.subscription)
    } else if (p.kind === 'credits') {
      if (p.org) run(ctx.db, 'update orgs set credits = credits + ? where id = ?', p.credits ?? 0, p.org)
      else run(ctx.db, 'update accounts set credits = credits + ? where id = ?', p.credits ?? 0, acc.id)
    }
    return true
  })
  if (!fresh) return
  const what =
    p.kind === 'pro'
      ? 'Your Pro subscription is active.'
      : p.kind === 'studio'
        ? `Your Studio organization is active with ${p.seats} seats.`
        : `${p.credits} credits were added. They never expire.`
  ctx.mail.queue(acc.email, 'receipt', 'Payment received', [
    what,
    refs.amount ? `Amount: ${money(ctx, refs.amount)}.` : '',
    'Your full receipt is available from the payment provider.',
  ])
}

function verifySignature(payload: Buffer, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]))
  const t = Number(parts.t)
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false
  const expected = createHmac('sha256', secret).update(`${t}.${payload.toString('utf8')}`).digest()
  return header
    .split(',')
    .filter((kv) => kv.startsWith('v1='))
    .some((kv) => {
      const got = Buffer.from(kv.slice(3), 'hex')
      return got.length === expected.length && timingSafeEqual(got, expected)
    })
}

function bySubscription(ctx: Ctx, sub: string): { account?: AccountRow; org?: OrgRow } {
  const org = one<OrgRow>(ctx.db, 'select * from orgs where stripe_subscription = ?', sub)
  if (org) return { org }
  return { account: one<AccountRow>(ctx.db, 'select * from accounts where stripe_subscription = ?', sub) }
}

export function webhook(ctx: Ctx, payload: Buffer, signature: string | undefined): void {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret || !signature || !verifySignature(payload, signature, secret)) fail(400, 'Invalid signature.')
  const event = JSON.parse(payload.toString('utf8')) as { id: string; type: string; data: { object: any } }
  const o = event.data.object
  switch (event.type) {
    case 'checkout.session.completed': {
      if (o.payment_status !== 'paid' && o.payment_status !== 'no_payment_required') return
      const m = o.metadata ?? {}
      applyPurchase(
        ctx,
        {
          kind: m.kind,
          account: m.account,
          seats: m.seats ? Number(m.seats) : undefined,
          orgName: m.orgName,
          credits: m.credits ? Number(m.credits) : undefined,
          org: m.org || undefined,
        },
        { customer: o.customer ?? null, subscription: o.subscription ?? null, ref: o.id, amount: o.amount_total },
      )
      return
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const target = bySubscription(ctx, o.id)
      // A late or failed payment leaves the plan as it was; only an ended
      // subscription turns the plan off.
      const ended = event.type === 'customer.subscription.deleted' || ['canceled', 'unpaid', 'incomplete_expired'].includes(o.status)
      const active = ended ? 0 : 1
      const quantity = o.items?.data?.[0]?.quantity
      if (target.org) {
        run(ctx.db, 'update orgs set plan_active = ? where id = ?', active, target.org.id)
        if (Number.isInteger(quantity)) {
          const members = (ctx.db.prepare('select count(*) as n from org_members where org_id = ?').get(target.org.id) as { n: number }).n
          run(ctx.db, 'update orgs set seats = ? where id = ?', Math.max(quantity, members), target.org.id)
        }
      } else if (target.account) {
        run(ctx.db, 'update accounts set plan_active = ? where id = ?', active, target.account.id)
      }
      return
    }
    case 'invoice.payment_failed': {
      const email = o.customer_email as string | undefined
      if (email) {
        ctx.mail.queue(email, 'payment-failed', 'A payment did not go through', [
          'A payment for your NameTempest subscription did not go through. Your plan stays as it was for now.',
          'You can update your card from the billing page of your account.',
        ])
      }
      ctx.alerts.failed('billing', 'invoice', o.customer ?? null, 'Payment failed', 'invoice.payment_failed')
      return
    }
    case 'invoice.paid': {
      if (o.billing_reason === 'subscription_cycle' && o.customer_email) {
        ctx.mail.queue(o.customer_email, 'receipt', 'Subscription renewed', [
          `Your subscription renewed. Amount: ${money(ctx, o.amount_paid ?? 0)}.`,
        ])
      }
      return
    }
  }
}

// Change the seats of a Studio subscription.
export async function changeSeats(ctx: Ctx, org: OrgRow, seats: number): Promise<void> {
  if (ctx.billingMode === 'stripe' && org.stripe_subscription) {
    const sub = await stripe(ctx, 'GET', `/v1/subscriptions/${org.stripe_subscription}`)
    const item = sub.items?.data?.[0]?.id
    if (!item) fail(502, 'The payment provider did not return the subscription. Seats have not changed. Try again.', { retry: true })
    await stripe(ctx, 'POST', `/v1/subscriptions/${org.stripe_subscription}`, {
      'items[0][id]': item,
      'items[0][quantity]': seats,
      proration_behavior: 'create_prorations',
    })
  }
  run(ctx.db, 'update orgs set seats = ? where id = ?', seats, org.id)
}

export async function cancelSubscription(ctx: Ctx, subscription: string | null): Promise<void> {
  if (ctx.billingMode === 'stripe' && subscription) await stripe(ctx, 'DELETE', `/v1/subscriptions/${subscription}`)
}
