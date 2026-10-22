// End-to-end checks of the success criteria through the HTTP API.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { Browser, projectWithDescription, startServer } from './helpers.ts'
import type { TestServer } from './helpers.ts'
import { grantOperatorByHand } from '../server/admin.ts'
import { purge } from '../server/account.ts'

process.env.NT_TRUST_PROXY = '1'

let s: TestServer
before(async () => {
  s = await startServer()
})
after(async () => {
  await s.close()
})

let ipCounter = 1
const browser = () => new Browser(s.url, `10.1.0.${ipCounter++}`)

test('a first visitor with no account can do a whole naming job', async () => {
  const b = browser()
  const me = await b.get('/api/me')
  assert.equal(me.body.account, null)
  assert.deepEqual([me.body.allowance.rounds.limit, me.body.allowance.revisions.limit, me.body.allowance.checks.limit], [5, 3, 20])
  const levels = me.body.levels.map((l: any) => [l.level, l.multiplier])
  assert.deepEqual(levels, [['quick', 1], ['balanced', 2], ['thorough', 3]])

  const pid = await projectWithDescription(b)
  const round = await b.post(`/api/projects/${pid}/rounds`, { level: 'balanced', roundId: 'r1' })
  assert.equal(round.status, 200, round.text)
  assert.equal(round.body.added.length, 12)
  for (const c of round.body.added) {
    assert.ok(c.name && c.reason && c.style)
    assert.equal(c.domainStatus, 'unchecked')
  }
  let a = (await b.get('/api/me')).body.allowance
  assert.equal(a.rounds.used, 2)

  // Keep three, reject one, then revise once.
  const [k1, k2, k3, r1] = round.body.added
  for (const c of [k1, k2, k3]) await b.post(`/api/projects/${pid}/candidates/${c.id}`, { status: 'kept' })
  await b.post(`/api/projects/${pid}/candidates/${r1.id}`, { status: 'rejected' })
  const rev = await b.post(`/api/projects/${pid}/revisions`, { level: 'quick', roundId: 'r2', direction: 'shorter names', buildOn: [k1.id] })
  assert.equal(rev.status, 200, rev.text)
  assert.ok(rev.body.added.length >= 5)
  const names = new Set((await b.get(`/api/projects/${pid}`)).body.candidates.map((c: any) => c.name.toLowerCase()))
  assert.equal(names.size, (await b.get(`/api/projects/${pid}`)).body.candidates.length, 'no name appears twice')
  a = (await b.get('/api/me')).body.allowance
  assert.equal(a.revisions.used, 1)
  assert.equal(a.rounds.used, 2, 'a revision spends nothing from the rounds counter')

  // Check the shortlist's domains.
  const check = await b.post(`/api/projects/${pid}/check`, { ids: [k1.id, k2.id, k3.id] })
  assert.equal(check.status, 200, check.text)
  for (const r of check.body.results) assert.equal(r.domainStatus, 'available')
  assert.equal((await b.get('/api/me')).body.allowance.checks.used, 3)

  // Copy the shortlist away.
  const txt = await b.get(`/api/export?project=${pid}&format=txt&list=shortlist`)
  assert.equal(txt.text.trim().split('\n').length, 3)
  assert.match(txt.headers.get('content-disposition')!, /attachment/)
  const csv = await b.get(`/api/export?project=${pid}&format=csv`)
  assert.match(csv.text, /domain status/)
})

test('taken, not valid and duplicate names are handled honestly', async () => {
  const b = browser()
  const pid = await projectWithDescription(b)
  const project = (await b.get(`/api/projects/${pid}`)).body
  // Put specific names on the list as a round would.
  const { addCandidates } = await import('../server/projects.ts')
  const actor = { deviceId: b.jar.get('nt_device')!, deviceAnchor: 1, ipHash: 'x', account: null, org: null }
  const added = addCandidates(s.ctx, actor, project.id, 1, [
    { name: 'Taken Name', reason: 'r', style: 's' },
    { name: 'Taken-Name', reason: 'r', style: 's' },
    { name: '東京', reason: 'r', style: 's' },
    { name: 'Takenname', reason: 'r', style: 's' },
  ])
  assert.equal(added.length, 2, 'names that differ only by punctuation or case are one name')
  const r = await b.post(`/api/projects/${pid}/check`, { ids: added.map((c) => c.id) })
  const byName = Object.fromEntries(r.body.results.map((c: any) => [c.name, c]))
  assert.equal(byName['Taken Name'].domainStatus, 'taken')
  assert.equal(byName['東京'].domainStatus, 'not valid')
  assert.ok(byName['東京'].domainReason)
  assert.equal(r.body.spent, 1, 'a not-valid name spends no check')
})

test('the gate keeps the work and blocks only new counted actions', async () => {
  const b = browser()
  const pid = await projectWithDescription(b)
  // Thorough costs 3 of 5; a second Thorough round cannot be paid.
  assert.equal((await b.post(`/api/projects/${pid}/rounds`, { level: 'thorough' })).status, 200)
  const before = (await b.get(`/api/projects/${pid}`)).body.candidates.length
  const gated = await b.post(`/api/projects/${pid}/rounds`, { level: 'thorough' })
  assert.equal(gated.status, 402)
  assert.equal(gated.body.gate, true)
  assert.match(gated.body.ranOut, /needs 3 generation rounds and you have 2 left/)
  assert.ok(gated.body.resetsAt > Date.now())
  assert.equal(gated.body.canBuyCredits, false)
  // Nothing was removed, and reading, removing and exporting still work.
  const after = (await b.get(`/api/projects/${pid}`)).body
  assert.equal(after.candidates.length, before)
  assert.equal((await b.post(`/api/projects/${pid}/candidates/${after.candidates[0].id}`, { status: 'rejected' })).status, 200)
  assert.equal((await b.get(`/api/export?project=${pid}&format=txt`)).status, 200)
  // A cheaper level still fits.
  assert.equal((await b.post(`/api/projects/${pid}/rounds`, { level: 'quick' })).status, 200)
})

test('a failed round spends nothing and offers a retry', async () => {
  const b = browser()
  const pid = await projectWithDescription(b)
  const original = s.ctx.modelFor
  s.ctx.modelFor = () => ({ call: async () => ({ not: 'the right shape' }) })
  try {
    const r = await b.post(`/api/projects/${pid}/rounds`, { level: 'quick' })
    assert.equal(r.status, 502)
    assert.equal(r.body.retry, true)
    assert.doesNotMatch(r.body.error, /HTTP|stack|claude/i)
    assert.match(r.body.error, /Nothing was taken/)
  } finally {
    s.ctx.modelFor = original
  }
  assert.equal((await b.get('/api/me')).body.allowance.rounds.used, 0)
})

test('separate projects in one browser never share names', async () => {
  const b = browser()
  const p1 = await projectWithDescription(b, 'One')
  const p2 = await b.post('/api/projects', { name: 'Two' })
  await b.patch(`/api/projects/${p2.body.id}`, { description: 'A garden design studio for small city courtyards' })
  await b.post(`/api/projects/${p1}/rounds`, { level: 'quick' })
  const two = (await b.get(`/api/projects/${p2.body.id}`)).body
  assert.equal(two.candidates.length, 0)
  // Another browser cannot see either.
  const other = browser()
  assert.equal((await other.get(`/api/projects/${p1}`)).status, 404)
  assert.equal((await other.get('/api/projects')).body.length, 0)
})

test('signing in attaches the work and never hands out a second allowance', async () => {
  const b = browser()
  const pid = await projectWithDescription(b)
  await b.post(`/api/projects/${pid}/rounds`, { level: 'thorough' }) // 3 rounds used on the device
  const signup = await b.post('/api/auth/signup', { email: 'solo@example.com', password: 'correct horse battery' })
  assert.equal(signup.status, 200, signup.text)
  assert.equal(signup.body.attached, 1)
  const me = (await b.get('/api/me')).body
  assert.equal(me.account.email, 'solo@example.com')
  assert.equal(me.allowance.subject, 'account')
  assert.equal(me.allowance.rounds.used, 3, 'the account takes the higher used count')
  assert.equal((await b.get('/api/projects')).body[0].id, pid)

  // A second device signing in reads the same counters and the same work.
  const d2 = browser()
  const login = await d2.post('/api/auth/login', { email: 'solo@example.com', password: 'correct horse battery' })
  assert.equal(login.status, 200)
  assert.equal((await d2.get('/api/me')).body.allowance.rounds.used, 3)
  assert.equal((await d2.get(`/api/projects/${pid}`)).status, 200)

  // Clearing the browser after sign-in does not delete the account's work.
  const fresh = new Browser(s.url, b.ip)
  assert.equal((await fresh.get(`/api/projects/${pid}`)).status, 404)
  await fresh.post('/api/auth/login', { email: 'solo@example.com', password: 'correct horse battery' })
  assert.equal((await fresh.get(`/api/projects/${pid}`)).status, 200)

  // Signing out returns to anonymous counting, without winning back allowance.
  await b.post('/api/auth/logout')
  const anon = (await b.get('/api/me')).body
  assert.equal(anon.account, null)
  assert.equal(anon.allowance.rounds.used, 3)
  assert.equal((await b.get(`/api/projects/${pid}`)).status, 404)

  assert.equal((await b.post('/api/auth/login', { email: 'solo@example.com', password: 'wrong password!' })).status, 401)
})

test('magic links are single use and only the newest works', async () => {
  const b = browser()
  const email = 'link@example.com'
  await b.post('/api/auth/magic', { email })
  await b.post('/api/auth/magic', { email })
  await s.ctx.mail.flush()
  const bodies = s.ctx.mail.recent(email).map((m) => m.body)
  assert.equal(bodies.length, 2)
  assert.match(bodies[0], /^NameTempest \(nametempest\.com\) is writing because you asked for a sign-in link\./)
  const token = (body: string) => /#\/magic\/([\w-]+)/.exec(body)![1]
  const [newest, older] = bodies.map(token)
  const old = await b.post('/api/auth/magic/verify', { token: older })
  assert.equal(old.status, 400)
  assert.match(old.body.error, /newer sign-in link/)
  assert.equal((await b.post('/api/auth/magic/verify', { token: newest })).status, 200)
  assert.equal((await b.get('/api/me')).body.account.email, email)
  const again = await new Browser(s.url).post('/api/auth/magic/verify', { token: newest })
  assert.match(again.body.error, /already been used/)
})

test('the network ceiling stops free use from one address, but not a signed-in account', async () => {
  s.ctx.settings.setNumber('network.ceiling', 6, 'test', 'test')
  try {
    const ip = '10.9.9.9'
    const first = new Browser(s.url, ip)
    const p1 = await projectWithDescription(first)
    for (let i = 0; i < 5; i++) assert.equal((await first.post(`/api/projects/${p1}/rounds`, { level: 'quick' })).status, 200)
    // Clearing the browser gives a fresh device, but the address is nearly used up.
    const cleared = new Browser(s.url, ip)
    const p2 = await projectWithDescription(cleared)
    assert.equal((await cleared.post(`/api/projects/${p2}/rounds`, { level: 'quick' })).status, 200)
    const blocked = await cleared.post(`/api/projects/${p2}/rounds`, { level: 'quick' })
    assert.equal(blocked.status, 402)
    assert.equal(blocked.body.network, true)
    assert.match(blocked.body.ranOut, /free use from this network is used up/)
    // Signing in with an account that has allowance continues the work.
    await cleared.post('/api/auth/signup', { email: 'shared-ip@example.com', password: 'a long password' })
    const ok = await cleared.post(`/api/projects/${p2}/rounds`, { level: 'quick' })
    assert.equal(ok.status, 200, ok.text)
  } finally {
    s.ctx.settings.resetNumber('network.ceiling', 'test', 'test')
  }
})

test('credits pay for rounds after the plan allowance, and never expire', async () => {
  const b = browser()
  await b.post('/api/auth/signup', { email: 'credits@example.com', password: 'a long password' })
  const pid = await projectWithDescription(b)
  assert.equal((await b.post('/api/billing/checkout', { kind: 'credits', packs: 1 })).status, 200)
  assert.equal((await b.get('/api/me')).body.allowance.credits, 10)
  await b.post(`/api/projects/${pid}/rounds`, { level: 'thorough' })
  await b.post(`/api/projects/${pid}/rounds`, { level: 'balanced' })
  let a = (await b.get('/api/me')).body.allowance
  assert.equal(a.rounds.used, 5)
  assert.equal(a.credits, 10, 'the monthly allowance is spent first')
  await b.post(`/api/projects/${pid}/rounds`, { level: 'thorough' })
  a = (await b.get('/api/me')).body.allowance
  assert.equal(a.credits, 7, 'Thorough spends three credits')
  const receipt = s.ctx.mail.recent('credits@example.com').find((m) => m.kind === 'receipt')
  assert.ok(receipt)
  assert.doesNotMatch(receipt!.body, /sourdough/i, 'emails hold no part of the work')
})

test('a Studio shares projects live between members within its seats', async () => {
  const owner = browser()
  await owner.post('/api/auth/signup', { email: 'owner@studio.com', password: 'a long password' })
  assert.equal((await owner.post('/api/billing/checkout', { kind: 'studio', seats: 2, orgName: 'Tiny' })).status, 400)
  assert.equal((await owner.post('/api/billing/checkout', { kind: 'studio', seats: 3, orgName: 'Atelier' })).status, 200)
  const me = (await owner.get('/api/me')).body
  assert.equal(me.account.plan, 'studio')
  assert.equal(me.allowance.subject, 'organization')
  assert.equal(me.allowance.rounds.limit, 150)

  const members = [browser(), browser()]
  const emails = ['ana@studio.com', 'ben@studio.com']
  for (let i = 0; i < 2; i++) {
    await owner.post('/api/org/invite', { email: emails[i] })
    await s.ctx.mail.flush()
    const body = s.ctx.mail.recent(emails[i]).find((m) => m.kind === 'invite')!.body
    const token = /#\/invite\/([\w-]+)/.exec(body)![1]
    await members[i].post('/api/auth/signup', { email: emails[i], password: 'a long password' })
    const acc = await members[i].post(`/api/invite/${token}/accept`)
    assert.equal(acc.status, 200, acc.text)
  }
  // A fourth person cannot join: no free seat.
  const extra = browser()
  await owner.post('/api/org/invite', { email: 'cara@studio.com' })
  await s.ctx.mail.flush()
  const t3 = /#\/invite\/([\w-]+)/.exec(s.ctx.mail.recent('cara@studio.com')[0].body)![1]
  await extra.post('/api/auth/signup', { email: 'cara@studio.com', password: 'a long password' })
  const full = await extra.post(`/api/invite/${t3}/accept`)
  assert.equal(full.status, 409)
  assert.match(full.body.error, /no free seat/)

  // Ana shares a project; Ben sees it and his change reaches Ana live.
  const [ana, ben] = members
  const pid = await projectWithDescription(ana, 'Client A')
  assert.equal((await ben.get(`/api/projects/${pid}`)).status, 404, 'private by default')
  await ana.patch(`/api/projects/${pid}`, { shared: true })
  assert.equal((await ben.get(`/api/projects/${pid}`)).status, 200)
  assert.equal((await extra.get(`/api/projects/${pid}`)).status, 404, 'nobody outside the studio sees it')

  const events: any[] = []
  const controller = new AbortController()
  const stream = await fetch(`${s.url}/api/projects/${pid}/events`, {
    headers: { cookie: [...ana.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    signal: controller.signal,
  })
  const reader = stream.body!.getReader()
  const reading = (async () => {
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value)
        for (const line of buf.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)))
        buf = buf.slice(buf.lastIndexOf('\n') + 1)
      }
    } catch {
      // aborted
    }
  })()
  const round = await ben.post(`/api/projects/${pid}/rounds`, { level: 'quick' })
  assert.equal(round.status, 200)
  await new Promise((r) => setTimeout(r, 100))
  const live = events.filter((e) => e.type === 'candidate')
  assert.equal(live.length, round.body.added.length)
  assert.equal(live[0].candidate.addedBy, 'ben@studio.com')
  controller.abort()
  await reading

  // Usage inside the shared project counts against the organization.
  assert.equal((await owner.get('/api/me')).body.allowance.rounds.used, 1)

  // Two members saving the same note at the same moment keep both versions.
  const note = await ana.post(`/api/projects/${pid}/notes`, { text: 'first' })
  const v = note.body.note.version
  const e1 = await ana.post(`/api/projects/${pid}/notes`, { noteId: note.body.note.id, text: 'ana edit', baseVersion: v })
  const e2 = await ben.post(`/api/projects/${pid}/notes`, { noteId: note.body.note.id, text: 'ben edit', baseVersion: v })
  assert.equal(e1.body.conflict, false)
  assert.equal(e2.body.conflict, true)
  const notes = (await ana.get(`/api/projects/${pid}`)).body.notes
  assert.deepEqual(notes.map((n: any) => n.body).sort(), ['ana edit', 'ben edit'])

  // Export of a shared project says who added each name.
  assert.match((await ana.get(`/api/export?project=${pid}&format=csv`)).text, /ben@studio\.com/)

  // Removing Ben ends his access; seats cannot drop below members.
  const benId = (await ben.get('/api/me')).body.account.id
  assert.equal((await owner.post(`/api/org/members/${benId}/remove`)).status, 200)
  assert.equal((await ben.get(`/api/projects/${pid}`)).status, 404)
  assert.equal((await owner.post('/api/org/seats', { seats: 2 })).status, 400)
})

test('deleting an account keeps it restorable for 30 days, then drops it', async () => {
  const b = browser()
  await b.post('/api/auth/signup', { email: 'leaving@example.com', password: 'a long password' })
  const pid = await projectWithDescription(b)
  const del = await b.post('/api/account/delete')
  assert.equal(del.status, 200)
  assert.equal((await b.get('/api/me')).body.account, null)
  // Sign in within the grace period: restored in full.
  const back = await b.post('/api/auth/login', { email: 'leaving@example.com', password: 'a long password' })
  assert.equal(back.body.restored, true)
  assert.equal((await b.get(`/api/projects/${pid}`)).status, 200)
  // Delete again and let 30 days pass.
  await b.post('/api/account/delete')
  purge(s.ctx, Date.now() + 31 * 24 * 60 * 60 * 1000)
  assert.equal((await b.post('/api/auth/login', { email: 'leaving@example.com', password: 'a long password' })).status, 401)
  assert.equal(s.ctx.db.prepare('select count(*) as n from projects where id = ?').get(pid)!.n, 0)
})

test('deleting a project removes it from every view', async () => {
  const b = browser()
  const pid = await projectWithDescription(b)
  await b.post(`/api/projects/${pid}/rounds`, { level: 'quick' })
  assert.equal((await b.del(`/api/projects/${pid}`)).status, 200)
  assert.equal((await b.get(`/api/projects/${pid}`)).status, 404)
  assert.equal(s.ctx.db.prepare('select count(*) as n from candidates where project_id = ?').get(pid)!.n, 0)
})

test('the admin interface is for the operator only, validates and records every change', async () => {
  const op = browser()
  await op.post('/api/auth/signup', { email: 'operator@nametempest.com', password: 'a long password' })
  assert.equal((await op.get('/api/admin')).status, 403)
  grantOperatorByHand(s.ctx, 'operator@nametempest.com', true)
  const o = await op.get('/api/admin')
  assert.equal(o.status, 200)
  assert.ok(o.body.settings.find((x: any) => x.key === 'free.rounds'))
  assert.equal((await op.post('/api/admin/setting', { key: 'free.rounds', value: 6 })).status, 400, 'a reason is required')
  assert.match((await op.post('/api/admin/setting', { key: 'free.rounds', value: -1, reason: 'x' })).body.error, /positive whole number/)
  assert.equal((await op.post('/api/admin/setting', { key: 'free.rounds', value: 8, reason: 'launch' })).status, 200)
  assert.equal((await browser().get('/api/me')).body.allowance.rounds.limit, 8)
  await op.post('/api/admin/setting', { key: 'free.rounds', clear: true, reason: 'back' })

  // Marking a level unavailable shows a plain message instead of a failing round.
  await op.post('/api/admin/part', { part: 'level:thorough', unavailable: true, reason: 'provider outage' })
  const b = browser()
  const pid = await projectWithDescription(b)
  const r = await b.post(`/api/projects/${pid}/rounds`, { level: 'thorough' })
  assert.equal(r.status, 503)
  assert.match(r.body.error, /not available right now/)
  await op.post('/api/admin/part', { part: 'level:thorough', unavailable: false, reason: 'recovered' })

  const people = await op.get('/api/admin/people?q=solo@')
  assert.equal(people.body[0].email, 'solo@example.com')
  await op.post('/api/admin/credits', { accountId: people.body[0].id, credits: 4, reason: 'support' })
  const audit = (await op.get('/api/admin')).body.audit
  assert.ok(audit.some((a: any) => a.action === 'credits granted' && a.reason === 'support'))

  // Removing the role ends admin access at once.
  grantOperatorByHand(s.ctx, 'operator@nametempest.com', false)
  assert.equal((await op.get('/api/admin')).status, 403)
})

test('mutating requests must be JSON, so another site cannot post forms', async () => {
  const res = await fetch(`${s.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' })
  assert.equal(res.status, 415)
})
