// The JSON API the browser uses.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Ctx } from './context.ts'
import { unavailableParts } from './context.ts'
import type { Actor } from './allowance.ts'
import { allowance, levelInfo } from './allowance.ts'
import {
  accountByEmail,
  checkPassword,
  completeSignIn,
  consumeMagicLink,
  createAccount,
  endSession,
  hashPassword,
  issueMagicLink,
  normalEmail,
  requireAccount,
  resolveActor,
  verifyPassword,
} from './auth.ts'
import { HttpError, RateLimit, fail, jsonBody, rawBody, send, sendFile, str, strList } from './http.ts'
import {
  createProject,
  deleteNote,
  deleteProject,
  detail,
  getProject,
  listProjects,
  resolveConflict,
  saveNote,
  setStatus,
  updateProject,
} from './projects.ts'
import { cancelRound, checkDomains, generate, revise } from './rounds.ts'
import { plans, portal, startCheckout, webhook } from './billing.ts'
import { acceptInvite, closeOrg, invite, inviteInfo, leave, orgView, removeMember, revokeInvite, setSeats, transferOwnership } from './orgs.ts'
import { deletionPreview, exportFile, requestDeletion, setEmailPrefs } from './account.ts'
import * as admin from './admin.ts'
import { OPTIONAL_EMAILS } from './email.ts'
import { run } from './db.ts'
import type { Me } from '../shared/types.ts'

type Handler = (ctx: Ctx, actor: Actor, req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<unknown> | unknown

const routes: { method: string; pattern: RegExp; handler: Handler }[] = []
function route(method: string, path: string, handler: Handler) {
  const pattern = new RegExp('^' + path.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$')
  routes.push({ method, pattern, handler })
}

const authLimit = new RateLimit(30, 10 * 60 * 1000)
const emailLimit = new RateLimit(5, 15 * 60 * 1000)

function limitAuth(actor: Actor) {
  if (!authLimit.take(actor.ipHash)) fail(429, 'Too many sign-in attempts from this network. Wait a few minutes and try again.')
}

export function me(ctx: Ctx, actor: Actor): Me {
  const a = actor.account
  return {
    device: actor.deviceId,
    account: a
      ? {
          id: a.id,
          email: a.email,
          plan: actor.org?.plan_active ? 'studio' : a.plan === 'pro' && a.plan_active ? 'pro' : 'free',
          planActive: a.plan_active === 1 || actor.org?.plan_active === 1,
          credits: a.credits,
          operator: a.operator === 1,
          hasPassword: !!a.password_hash,
          emailPrefs: Object.fromEntries(
            Object.keys(OPTIONAL_EMAILS).map((k) => [k, (JSON.parse(a.email_prefs) as Record<string, boolean>)[k] !== false]),
          ),
          org: actor.org ? { id: actor.org.id, name: actor.org.name, role: actor.org.role, seats: actor.org.seats } : null,
        }
      : null,
    allowance: allowance(ctx.db, ctx.settings, actor),
    levels: levelInfo(ctx.settings, unavailableParts(ctx)),
    styleLists: ctx.settings.config().styleLists,
    freshnessMinutes: ctx.settings.num('domain.freshnessMinutes'),
  }
}

// --- identity -------------------------------------------------------------

route('GET', '/api/me', (ctx, actor) => me(ctx, actor))

route('POST', '/api/auth/signup', async (ctx, actor, req, res) => {
  limitAuth(actor)
  const body = await jsonBody(req)
  const email = normalEmail(str(body, 'email', 254, true))
  const password = str(body, 'password', 200, true)
  checkPassword(password)
  if (accountByEmail(ctx, email)) fail(409, 'An account with this email already exists. Sign in instead, or use a sign-in link.')
  const account = createAccount(ctx, actor, email, await hashPassword(password))
  return completeSignIn(ctx, actor, res, account)
})

route('POST', '/api/auth/login', async (ctx, actor, req, res) => {
  limitAuth(actor)
  const body = await jsonBody(req)
  const email = normalEmail(str(body, 'email', 254, true))
  const password = str(body, 'password', 200, true)
  const account = accountByEmail(ctx, email)
  if (!account || !(await verifyPassword(password, account.password_hash))) {
    fail(401, 'That email and password do not match. Try again, or sign in with an email link.')
  }
  return completeSignIn(ctx, actor, res, account)
})

route('POST', '/api/auth/magic', async (ctx, actor, req) => {
  limitAuth(actor)
  const body = await jsonBody(req)
  const email = normalEmail(str(body, 'email', 254, true))
  if (!emailLimit.take(email)) fail(429, 'Several links were sent to this address just now. Wait a few minutes before asking again.')
  const next = typeof body.next === 'string' && /^#\/[\w/-]*$/.test(body.next) ? body.next : null
  const t = issueMagicLink(ctx, email, next)
  ctx.mail.queue(email, 'magic', 'Your sign-in link', [
    `Sign in to NameTempest with this link: ${ctx.baseUrl}/#/magic/${t}`,
    'The link works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.',
  ])
  return { sent: true }
})

route('POST', '/api/auth/magic/verify', async (ctx, actor, req, res) => {
  limitAuth(actor)
  const body = await jsonBody(req)
  const { email, next } = consumeMagicLink(ctx, str(body, 'token', 200, true))
  const account = accountByEmail(ctx, email) ?? createAccount(ctx, actor, email, null)
  return { ...completeSignIn(ctx, actor, res, account), next }
})

route('POST', '/api/auth/logout', (ctx, _actor, req, res) => {
  endSession(ctx, req, res)
  return { ok: true }
})

route('POST', '/api/auth/password', async (ctx, actor, req) => {
  const a = requireAccount(actor)
  const body = await jsonBody(req)
  const password = str(body, 'password', 200, true)
  checkPassword(password)
  run(ctx.db, 'update accounts set password_hash = ? where id = ?', await hashPassword(password), a.id)
  return { ok: true }
})

// --- projects ---------------------------------------------------------------

route('GET', '/api/projects', (ctx, actor) => listProjects(ctx, actor))

route('POST', '/api/projects', async (ctx, actor, req) => {
  const body = await jsonBody(req)
  const p = createProject(ctx, actor, str(body, 'name', 120))
  return detail(ctx, actor, p)
})

route('GET', '/api/projects/:id', (ctx, actor, _req, _res, [pid]) => detail(ctx, actor, getProject(ctx, actor, pid)))

route('PATCH', '/api/projects/:id', async (ctx, actor, req, _res, [pid]) => {
  const p = getProject(ctx, actor, pid)
  return detail(ctx, actor, updateProject(ctx, actor, p, await jsonBody(req)))
})

route('DELETE', '/api/projects/:id', (ctx, actor, _req, _res, [pid]) => {
  deleteProject(ctx, actor, getProject(ctx, actor, pid))
  return { ok: true }
})

route('POST', '/api/projects/:id/resolve', async (ctx, actor, req, _res, [pid]) => {
  const body = await jsonBody(req)
  const keep = body.keep
  if (keep !== 'this' && keep !== 'other' && keep !== 'both') fail(400, 'Choose which copy to keep.')
  resolveConflict(ctx, actor, getProject(ctx, actor, pid), keep)
  return { ok: true }
})

route('POST', '/api/projects/:id/offer', async (ctx, actor, req, _res, [pid]) => {
  const p = getProject(ctx, actor, pid)
  const body = await jsonBody(req)
  if (body.keep === true) run(ctx.db, 'update projects set offered_from = null where id = ?', p.id)
  else deleteProject(ctx, actor, p)
  return { ok: true }
})

route('GET', '/api/projects/:id/events', (ctx, actor, _req, res, [pid]) => {
  getProject(ctx, actor, pid)
  ctx.live.subscribe(pid, res)
  return STREAM
})

route('POST', '/api/projects/:id/rounds', async (ctx, actor, req, _res, [pid]) => {
  const body = await jsonBody(req)
  return generate(ctx, actor, getProject(ctx, actor, pid), body)
})

route('POST', '/api/projects/:id/revisions', async (ctx, actor, req, _res, [pid]) => {
  const body = await jsonBody(req)
  return revise(ctx, actor, getProject(ctx, actor, pid), body)
})

route('POST', '/api/rounds/:id/cancel', (_ctx, actor, _req, _res, [rid]) => ({ cancelled: cancelRound(actor, rid) }))

route('POST', '/api/projects/:id/candidates/:cid', async (ctx, actor, req, _res, [pid, cid]) => {
  const p = getProject(ctx, actor, pid)
  const body = await jsonBody(req)
  return setStatus(ctx, actor, p.id, cid, body.status as never)
})

route('POST', '/api/projects/:id/check', async (ctx, actor, req, _res, [pid]) => {
  const body = await jsonBody(req)
  return checkDomains(ctx, actor, getProject(ctx, actor, pid), strList(body, 'ids'))
})

route('POST', '/api/projects/:id/notes', async (ctx, actor, req, _res, [pid]) => {
  const p = getProject(ctx, actor, pid)
  const body = await jsonBody(req)
  return saveNote(ctx, actor, p.id, {
    noteId: typeof body.noteId === 'string' ? body.noteId : undefined,
    candidateId: typeof body.candidateId === 'string' ? body.candidateId : null,
    text: str(body, 'text', 5000),
    baseVersion: typeof body.baseVersion === 'number' ? body.baseVersion : undefined,
  })
})

route('DELETE', '/api/projects/:id/notes/:nid', (ctx, actor, _req, _res, [pid, nid]) => {
  deleteNote(ctx, actor, getProject(ctx, actor, pid).id, nid)
  return { ok: true }
})

route('GET', '/api/export', (ctx, actor, _req, res, _p, url) => {
  const f = exportFile(ctx, actor, url.searchParams.get('project'), url.searchParams.get('format') ?? 'csv', url.searchParams.get('list') ?? 'all')
  sendFile(res, f.type, f.name, f.body)
  return STREAM
})

// --- billing and organizations ---------------------------------------------

route('GET', '/api/plans', (ctx) => ({ ...plans(ctx), mode: ctx.billingMode }))
route('POST', '/api/billing/checkout', async (ctx, actor, req) => startCheckout(ctx, actor, await jsonBody(req)))
route('POST', '/api/billing/portal', (ctx, actor) => portal(ctx, actor))

route('GET', '/api/org', (ctx, actor) => orgView(ctx, actor))
route('POST', '/api/org/invite', async (ctx, actor, req) => {
  invite(ctx, actor, str(await jsonBody(req), 'email', 254, true))
  return orgView(ctx, actor)
})
route('DELETE', '/api/org/invites/:id', (ctx, actor, _req, _res, [iid]) => {
  revokeInvite(ctx, actor, iid)
  return orgView(ctx, actor)
})
route('GET', '/api/invite/:token', (ctx, _actor, _req, _res, [t]) => {
  const { inv, org } = inviteInfo(ctx, t)
  return { email: inv.email, org: org.name }
})
route('POST', '/api/invite/:token/accept', (ctx, actor, _req, _res, [t]) => {
  acceptInvite(ctx, actor, t)
  return { ok: true }
})
route('POST', '/api/org/members/:id/remove', (ctx, actor, _req, _res, [mid]) => {
  removeMember(ctx, actor, mid)
  return { ok: true }
})
route('POST', '/api/org/leave', (ctx, actor) => {
  leave(ctx, actor)
  return { ok: true }
})
route('POST', '/api/org/transfer', async (ctx, actor, req) => {
  transferOwnership(ctx, actor, str(await jsonBody(req), 'memberId', 64, true))
  return { ok: true }
})
route('POST', '/api/org/seats', async (ctx, actor, req) => {
  await setSeats(ctx, actor, Number((await jsonBody(req)).seats))
  return { ok: true }
})
route('POST', '/api/org/close', async (ctx, actor) => {
  await closeOrg(ctx, actor)
  return { ok: true }
})

// --- account ----------------------------------------------------------------

route('POST', '/api/account/emails', async (ctx, actor, req) => setEmailPrefs(ctx, actor, await jsonBody(req)))
route('GET', '/api/account/deletion', (ctx, actor) => deletionPreview(ctx, actor))
route('POST', '/api/account/delete', (ctx, actor, req, res) => {
  const out = requestDeletion(ctx, actor)
  endSession(ctx, req, res)
  return out
})

// --- admin ------------------------------------------------------------------

route('GET', '/api/admin', (ctx, actor) => admin.overview(ctx, actor))
route('POST', '/api/admin/setting', async (ctx, actor, req) => admin.setSetting(ctx, actor, await jsonBody(req)) ?? { ok: true })
route('POST', '/api/admin/config', async (ctx, actor, req) => admin.setConfig(ctx, actor, await jsonBody(req)) ?? { ok: true })
route('POST', '/api/admin/part', async (ctx, actor, req) => admin.setUnavailable(ctx, actor, await jsonBody(req)) ?? { ok: true })
route('POST', '/api/admin/alerts/:id/dismiss', (ctx, actor, _req, _res, [aid]) => admin.dismissAlert(ctx, actor, Number(aid)) ?? { ok: true })
route('GET', '/api/admin/alerts/:id', (ctx, actor, _req, _res, [aid]) => admin.alertDetail(ctx, actor, Number(aid)))
route('GET', '/api/admin/people', (ctx, actor, _req, _res, _p, url) => admin.searchPeople(ctx, actor, url.searchParams.get('q') ?? ''))
route('POST', '/api/admin/credits', async (ctx, actor, req) => admin.grantCredits(ctx, actor, await jsonBody(req)) ?? { ok: true })
route('POST', '/api/admin/plan', async (ctx, actor, req) => admin.setPlan(ctx, actor, await jsonBody(req)) ?? { ok: true })
route('POST', '/api/admin/remove-from-org', async (ctx, actor, req) => admin.removeFromOrg(ctx, actor, await jsonBody(req)) ?? { ok: true })
route('POST', '/api/admin/seats', async (ctx, actor, req) => {
  await admin.setOrgSeats(ctx, actor, await jsonBody(req))
  return { ok: true }
})

// --- development helpers ----------------------------------------------------

route('GET', '/api/dev/outbox', (ctx, _actor, _req, _res, _p, url) => {
  if (!ctx.dev) fail(404, 'Not found.')
  return ctx.mail.recent(url.searchParams.get('to') ?? '')
})

const STREAM = Symbol('stream')

export async function handleApi(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const method = req.method ?? 'GET'
  try {
    if (method === 'POST' && url.pathname === '/api/stripe/webhook') {
      webhook(ctx, await rawBody(req, 1_000_000), req.headers['stripe-signature'] as string | undefined)
      return send(res, 200, { received: true })
    }
    // Cross-site forms cannot send JSON, so this keeps cookies from being
    // used by another site.
    if (method !== 'GET' && method !== 'HEAD' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      fail(415, 'Requests must be JSON.')
    }
    const actor = resolveActor(ctx, req, res)
    for (const r of routes) {
      if (r.method !== method) continue
      const m = r.pattern.exec(url.pathname)
      if (!m) continue
      const out = await r.handler(ctx, actor, req, res, m.slice(1).map(decodeURIComponent), url)
      if (out === STREAM) return
      return send(res, 200, out ?? { ok: true })
    }
    fail(404, 'Not found.')
  } catch (e) {
    if (e instanceof HttpError) {
      if (!res.headersSent) send(res, e.status, e.body)
      return
    }
    ctx.alerts.failed('app', url.pathname, null, 'Unexpected server error', e instanceof Error ? (e.stack ?? e.message) : String(e))
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on our side. Nothing was charged. Try again.', retry: true })
  }
}
