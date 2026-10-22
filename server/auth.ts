// Identity (Accounts). With no sign-in the browser carries an anonymous
// device identity. Sign-in is an email address with a password, or a
// single-use magic link sent by email.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { Ctx } from './context.ts'
import { id, one, run, token, tx } from './db.ts'
import type { AccountRow, Actor, OrgRow } from './allowance.ts'
import { mergeDeviceUsage } from './allowance.ts'
import { clientIp, cookies, fail, setCookie } from './http.ts'
import { attachDeviceProjects } from './projects.ts'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

export const MAGIC_LINK_MS = 15 * 60 * 1000
const YEAR = 365 * 24 * 60 * 60
const SESSION_AGE = 60 * 24 * 60 * 60

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(pw, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  const [kind, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), 64)
  const want = Buffer.from(hash, 'base64')
  return got.length === want.length && timingSafeEqual(got, want)
}

export function normalEmail(email: string): string {
  const e = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) fail(400, 'That does not look like an email address.')
  return e
}

export function checkPassword(pw: string): void {
  if (pw.length < 10) fail(400, 'Choose a password of at least 10 characters.')
  if (pw.length > 200) fail(400, 'That password is too long.')
}

function secure(ctx: Ctx): boolean {
  return ctx.baseUrl.startsWith('https://')
}

export function ipHash(ctx: Ctx, req: IncomingMessage): string {
  // One-way, and salted per month so it cannot be joined across months.
  const month = new Date().toISOString().slice(0, 7)
  return sha256(ctx.secret + '|' + month + '|' + clientIp(req, process.env.NT_TRUST_PROXY === '1'))
}

export function orgFor(ctx: Ctx, accountId: string): (OrgRow & { role: 'owner' | 'member' }) | null {
  return (
    one<OrgRow & { role: 'owner' | 'member' }>(
      ctx.db,
      'select o.*, m.role as role from org_members m join orgs o on o.id = m.org_id where m.account_id = ?',
      accountId,
    ) ?? null
  )
}

export function resolveActor(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Actor {
  const c = cookies(req)
  const now = Date.now()
  let deviceId = c.nt_device
  let device = deviceId ? one<{ id: string; anchor_day: number }>(ctx.db, 'select * from devices where id = ?', deviceId) : undefined
  if (!device) {
    deviceId = id('d_')
    const anchor = new Date(now).getUTCDate()
    run(ctx.db, 'insert into devices (id, created_at, anchor_day) values (?, ?, ?)', deviceId, now, anchor)
    device = { id: deviceId, anchor_day: anchor }
    setCookie(res, 'nt_device', deviceId, YEAR * 2, secure(ctx))
  }
  let account: AccountRow | null = null
  if (c.nt_session) {
    const s = one<{ account_id: string }>(ctx.db, 'select account_id from sessions where token_hash = ?', sha256(c.nt_session))
    if (s) {
      account = one<AccountRow>(ctx.db, 'select * from accounts where id = ? and deleted_at is null', s.account_id) ?? null
    }
  }
  return {
    deviceId: device.id,
    deviceAnchor: device.anchor_day,
    ipHash: ipHash(ctx, req),
    account,
    org: account ? orgFor(ctx, account.id) : null,
  }
}

export function startSession(ctx: Ctx, res: ServerResponse, accountId: string): void {
  const t = token()
  run(ctx.db, 'insert into sessions (token_hash, account_id, created_at) values (?, ?, ?)', sha256(t), accountId, Date.now())
  setCookie(res, 'nt_session', t, SESSION_AGE, secure(ctx))
}

export function endSession(ctx: Ctx, req: IncomingMessage, res: ServerResponse): void {
  const t = cookies(req).nt_session
  if (t) run(ctx.db, 'delete from sessions where token_hash = ?', sha256(t))
  setCookie(res, 'nt_session', '', 0, secure(ctx))
}

export interface SignInResult {
  account: AccountRow
  attached: number
  restored: boolean
  conflicts: number
}

// Everything that happens when a person signs in on a device: the session,
// a pending deletion undone, the device's work attached, and the counters
// merged so the month's free allowance is not handed out twice.
export function completeSignIn(ctx: Ctx, actor: Actor, res: ServerResponse, account: AccountRow): SignInResult {
  let restored = false
  if (account.deleted_at) {
    run(ctx.db, 'update accounts set deleted_at = null, purge_at = null where id = ?', account.id)
    restored = true
  }
  const org = orgFor(ctx, account.id)
  const attached = tx(ctx.db, () => attachDeviceProjects(ctx, actor.deviceId, account.id, org?.id ?? null))
  if (!org?.plan_active) mergeDeviceUsage(ctx.db, actor.deviceId, actor.deviceAnchor, account)
  startSession(ctx, res, account.id)
  const conflicts = (
    ctx.db.prepare('select count(*) as n from projects where account_id = ? and conflict_with is not null').get(account.id) as {
      n: number
    }
  ).n
  return { account: one<AccountRow>(ctx.db, 'select * from accounts where id = ?', account.id)!, attached, restored, conflicts }
}

export function createAccount(ctx: Ctx, actor: Actor, email: string, passwordHash: string | null): AccountRow {
  const aid = id('a_')
  run(
    ctx.db,
    'insert into accounts (id, email, password_hash, created_at, anchor_day) values (?, ?, ?, ?, ?)',
    aid,
    email,
    passwordHash,
    Date.now(),
    actor.deviceAnchor,
  )
  return one<AccountRow>(ctx.db, 'select * from accounts where id = ?', aid)!
}

export function accountByEmail(ctx: Ctx, email: string): AccountRow | undefined {
  return one<AccountRow>(ctx.db, 'select * from accounts where email = ?', email)
}

// A new link replaces any earlier one, so only one is valid at a time.
export function issueMagicLink(ctx: Ctx, email: string, next: string | null): string {
  const t = token()
  const now = Date.now()
  tx(ctx.db, () => {
    run(ctx.db, 'update magic_links set replaced = 1 where email = ? and used_at is null', email)
    run(
      ctx.db,
      'insert into magic_links (token_hash, email, created_at, expires_at, next) values (?, ?, ?, ?, ?)',
      sha256(t),
      email,
      now,
      now + MAGIC_LINK_MS,
      next,
    )
  })
  return t
}

export function consumeMagicLink(ctx: Ctx, t: string): { email: string; next: string | null } {
  const row = one<{ email: string; expires_at: number; used_at: number | null; replaced: number; next: string | null }>(
    ctx.db,
    'select * from magic_links where token_hash = ?',
    sha256(t),
  )
  const again = { fresh: true }
  if (!row) fail(400, 'This sign-in link is not valid. Ask for a fresh one below.', again)
  if (row.used_at) fail(400, 'This sign-in link has already been used. Ask for a fresh one below.', again)
  if (row.replaced) fail(400, 'A newer sign-in link was sent, so this one no longer works. Use the newest email, or ask for a fresh link below.', again)
  if (row.expires_at < Date.now()) fail(400, 'This sign-in link has expired. Ask for a fresh one below.', again)
  run(ctx.db, 'update magic_links set used_at = ? where token_hash = ?', Date.now(), sha256(t))
  return { email: row.email, next: row.next }
}

export function requireAccount(actor: Actor): AccountRow {
  if (!actor.account) fail(401, 'Sign in to do this.')
  return actor.account
}

export function requireOperator(actor: Actor): AccountRow {
  // Checked on every request, so removing the role ends every admin session.
  const a = requireAccount(actor)
  if (a.operator !== 1) fail(403, 'This page is only for the operator.')
  return a
}
