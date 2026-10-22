import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spellDomain } from '../shared/spelling.ts'
import { shortlist, toCsv, toText } from '../shared/export.ts'
import { period } from '../server/allowance.ts'
import { parseReply, nameKey } from '../server/model.ts'
import { openDb } from '../server/db.ts'
import { Settings } from '../server/settings.ts'
import { DomainChecker } from '../server/domain/check.ts'
import { Alerts } from '../server/alerts.ts'
import { fakeSources } from './helpers.ts'
import type { Candidate } from '../shared/types.ts'

test('spelling: one fixed rule from name to domain', () => {
  assert.deepEqual(spellDomain('Bright Oak'), { ok: true, label: 'brightoak', domain: 'brightoak.com' })
  assert.equal((spellDomain('Café Crème') as any).domain, 'cafecreme.com')
  assert.equal((spellDomain('Straße & Co.') as any).domain, 'strasseco.com')
  assert.equal((spellDomain('Kin-Folk!') as any).domain, 'kinfolk.com')
  assert.equal((spellDomain('Øresund 24') as any).domain, 'oresund24.com')
  // Same name, same domain.
  assert.equal((spellDomain('Bright Oak') as any).domain, (spellDomain('bright  oak') as any).domain)
})

test('spelling: names that cannot form a domain are not valid, with a plain reason', () => {
  const empty = spellDomain('東京!!')
  assert.equal(empty.ok, false)
  assert.match((empty as any).reason, /Nothing is left/)
  const long = spellDomain('a'.repeat(64))
  assert.equal(long.ok, false)
  assert.match((long as any).reason, /too long/)
  assert.equal(spellDomain('a'.repeat(63)).ok, true)
})

test('period: refreshes on the day of the first visit, clamped to short months', () => {
  const p = period(Date.UTC(2026, 9, 22, 12), 15)
  assert.equal(p.key, '2026-10-15')
  assert.equal(new Date(p.end).toISOString().slice(0, 10), '2026-11-15')
  const before = period(Date.UTC(2026, 9, 10), 15)
  assert.equal(before.key, '2026-09-15')
  const feb = period(Date.UTC(2027, 1, 28, 5), 31)
  assert.equal(feb.key, '2027-02-28')
  const jan = period(Date.UTC(2027, 0, 5), 31)
  assert.equal(jan.key, '2026-12-31')
})

test('model replies are checked against the expected shape', () => {
  assert.equal(parseReply('free text'), null)
  assert.equal(parseReply({ names: [{ name: 'X' }] }), null)
  const ok = parseReply({ names: [{ name: '  Oak   Lane ', reason: 'Fits.', style: 'compound' }, { name: '', reason: '', style: '' }] })
  assert.deepEqual(ok?.names, [{ name: 'Oak Lane', reason: 'Fits.', style: 'compound' }])
  assert.equal(nameKey('Café-Oak'), nameKey('cafe oak'))
})

test('settings: invalid values are refused, a bad stored value falls back', () => {
  const db = openDb(':memory:')
  const s = new Settings(db)
  assert.equal(s.num('free.rounds'), 5)
  assert.equal(s.num('round.batch'), 12)
  assert.match(s.setNumber('free.rounds', 0, 'op', 'r')!, /positive whole number/)
  assert.match(s.setNumber('free.rounds', 2.5, 'op', 'r')!, /positive whole number/)
  assert.match(s.setNumber('round.batch', 4, 'op', 'r')!, /at least 5/)
  assert.equal(s.setNumber('free.rounds', 7, 'op', 'more'), null)
  assert.equal(s.num('free.rounds'), 7)
  // A corrupted value keeps the last valid one in use.
  db.prepare("update settings set value = '\"oops\"' where key = 'free.rounds'").run()
  s.reload()
  assert.equal(s.num('free.rounds'), 7)
  const audit = db.prepare('select * from audit').all() as any[]
  assert.equal(audit.length, 1)
  assert.equal(audit[0].old_value, '5')
  assert.equal(audit[0].new_value, '7')
  assert.equal(s.resetNumber('free.rounds', 'op', 'back'), null)
  assert.equal(s.num('free.rounds'), 5)
  // There are exactly three levels.
  const cfg = structuredClone(s.config()) as any
  cfg.levels.extra = { label: 'Extra', model: 'm' }
  assert.match(s.setConfig(cfg, 'op', 'r')!, /exactly three/)
})

function checker(taken: Set<string>, opts: { rdapDown?: boolean } = {}) {
  const db = openDb(':memory:')
  const src = fakeSources(taken, opts)
  return { src, c: new DomainChecker(db, src, { freshnessMs: () => 60_000, timeoutMs: 200 }) }
}

test('domain check: name servers prove taken and stop the chain', async () => {
  const { src, c } = checker(new Set(['oak.com']))
  const r = await c.check('oak.com')
  assert.equal(r.status, 'taken')
  assert.deepEqual(src.calls, ['dns:oak.com'])
})

test('domain check: only a fresh RDAP not-found reports available', async () => {
  const { src, c } = checker(new Set())
  assert.equal((await c.check('free.com')).status, 'available')
  assert.deepEqual(src.calls, ['dns:free.com', 'rdap:free.com'])
  // A stored available result stands in for DNS, never for the confirmation.
  src.calls.length = 0
  assert.equal((await c.check('free.com')).status, 'available')
  assert.deepEqual(src.calls, ['rdap:free.com'])
})

test('domain check: when RDAP fails, WHOIS can prove taken but never free', async () => {
  const { src, c } = checker(new Set(), { rdapDown: true })
  const r = await c.check('maybe.com')
  assert.equal(r.status, 'unknown')
  assert.ok(r.reason)
  assert.deepEqual(src.calls, ['dns:maybe.com', 'rdap:maybe.com', 'whois:maybe.com'])
})

test('domain check: a slow lookup gives up and reports unknown', async () => {
  const db = openDb(':memory:')
  const slow = { ...fakeSources(new Set()), dns: () => new Promise<boolean>(() => {}) }
  const c = new DomainChecker(db, slow, { freshnessMs: () => 60_000, timeoutMs: 50 })
  const r = await c.check('slow.com')
  assert.equal(r.status, 'unknown')
  assert.match(r.reason!, /too long/)
})

test('domain check: taken is served from cache within the window, one lookup per domain', async () => {
  const { src, c } = checker(new Set(['oak.com']))
  await Promise.all([c.check('oak.com'), c.check('oak.com')])
  assert.equal(src.calls.length, 1)
  const r = await c.check('oak.com')
  assert.equal(r.status, 'taken')
  assert.equal(src.calls.length, 1)
})

test('alerts: a repeat raises an alert, twice in the window emails', () => {
  const db = openDb(':memory:')
  const notified: unknown[] = []
  const a = new Alerts(db, (x) => notified.push(x))
  a.failed('level:quick', 'generate', 'device:1', 'model failed', 'HTTP 500')
  assert.equal(a.list().length, 0)
  a.failed('level:quick', 'generate', 'device:2', 'model failed', 'HTTP 500')
  assert.equal(a.list().length, 1)
  assert.equal(notified.length, 0)
  a.failed('level:quick', 'generate', 'device:3', 'model failed', 'HTTP 500')
  assert.equal(notified.length, 1)
  a.dismiss(a.list()[0].id)
  a.failed('level:quick', 'generate', 'device:3', 'model failed', 'HTTP 500')
  assert.equal(a.list().filter((x) => !x.dismissed_at).length, 1)
})

const cand = (name: string, status: Candidate['status'], addedBy: string | null = null): Candidate => ({
  id: name,
  projectId: 'p',
  name,
  reason: `Because, "quoted"`,
  style: 'invented',
  domain: name.toLowerCase() + '.com',
  domainStatus: 'available',
  domainReason: null,
  checkedAt: 0,
  status,
  round: 1,
  addedBy,
  changedBy: null,
  createdAt: 0,
})

test('export: CSV and plain text', () => {
  const list = [cand('Oak', 'kept', 'a@x.com'), cand('=Fern', 'candidate')]
  const csv = toCsv(list.map((c) => ({ project: 'P', candidate: c, shared: true })), false)
  const lines = csv.trim().split('\r\n')
  assert.equal(lines[0], '"name","reason","style","domain","domain status","checked at","list status","added by"')
  assert.match(lines[1], /"Because, ""quoted"""/)
  assert.match(lines[2], /^"'=Fern"/)
  assert.equal(toText(shortlist(list)), 'Oak\n')
  assert.equal(toText(shortlist([cand('A', 'candidate'), cand('B', 'rejected')])), 'A\n')
})
