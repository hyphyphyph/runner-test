// Counted actions: generation rounds, revision rounds and domain checks
// (Generation, Revisions, EffortLevels, DomainCheck, Failures). Each one is
// quoted before it starts, gated if the allowance cannot pay, and charged only
// after it produced something. A failed or cancelled action spends nothing.

import type { Ctx } from './context.ts'
import { TLD, unavailableParts } from './context.ts'
import { run } from './db.ts'
import type { Actor } from './allowance.ts'
import { charge, levelInfo, quote, subjectOf } from './allowance.ts'
import { fail } from './http.ts'
import type { NameRequest, RawName } from './model.ts'
import { ModelError, parseReply } from './model.ts'
import type { ProjectRow } from './projects.ts'
import { addCandidates, author, candidate, candidates, setDomain, toProject } from './projects.ts'
import { spellDomain } from '../shared/spelling.ts'
import type { Candidate, Level, Style } from '../shared/types.ts'
import { LEVELS } from '../shared/types.ts'

const CHUNK = 4
const ATTEMPTS = 3
export const MAX_CONCURRENT_ROUNDS = 20

// Rounds beyond capacity wait in a queue and are told their place in it.
class RoundQueue {
  private running = 0
  private waiting: { start: () => void; tick: (place: number) => void; signal: AbortSignal }[] = []
  private max: number
  constructor(max: number) {
    this.max = max
  }
  async enter(signal: AbortSignal, tick: (place: number) => void): Promise<void> {
    if (this.running < this.max) {
      this.running++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const entry = { start: resolve, tick, signal }
      this.waiting.push(entry)
      tick(this.waiting.length)
      signal.addEventListener('abort', () => {
        this.waiting = this.waiting.filter((w) => w !== entry)
        this.notify()
        reject(new Error('cancelled'))
      })
    })
  }
  leave(): void {
    const next = this.waiting.shift()
    if (next) next.start()
    else this.running--
    this.notify()
  }
  private notify(): void {
    this.waiting.forEach((w, i) => w.tick(i + 1))
  }
}

const queue = new RoundQueue(MAX_CONCURRENT_ROUNDS)
const active = new Map<string, { controller: AbortController; owner: string }>()

export function cancelRound(actor: Actor, roundId: string): boolean {
  const r = active.get(roundId)
  if (!r || r.owner !== (actor.account?.id ?? actor.deviceId)) return false
  r.controller.abort()
  return true
}

function parseLevel(v: unknown): Level {
  if (typeof v !== 'string' || !LEVELS.includes(v as Level)) fail(400, 'Pick an effort level.')
  return v as Level
}

function styleOf(p: ProjectRow): Style {
  return JSON.parse(p.style)
}

interface RoundResult {
  added: Candidate[]
  dropped: string[]
  cancelled: boolean
  error: string | null
}

// Ask the model for `count` names in parallel chunks, so the first names
// appear quickly. Each chunk's reply is checked and retried a limited number
// of times. Names are added as each chunk arrives.
async function runModel(
  ctx: Ctx,
  actor: Actor,
  p: ProjectRow,
  level: Level,
  base: Omit<NameRequest, 'count' | 'exclude'>,
  count: number,
  round: number,
  roundId: string,
  signal: AbortSignal,
): Promise<{ added: Candidate[]; drop: string[]; errors: ModelError[] }> {
  const model = ctx.settings.config().levels[level].model
  const provider = ctx.modelFor(model)
  const sizes: number[] = []
  for (let left = count; left > 0; left -= CHUNK) sizes.push(Math.min(CHUNK, left))
  const added: Candidate[] = []
  const drop: string[] = []
  const errors: ModelError[] = []
  const exclude = () => candidates(ctx, p.id).map((c) => c.name)
  const ask = async (size: number, variation: number) => {
    const req: NameRequest = { ...base, count: size, exclude: exclude(), variation }
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (signal.aborted) return
      try {
        const raw = await provider.call(model, req, signal)
        const reply = parseReply(raw)
        if (!reply) throw new ModelError('The naming model replied in a shape we could not use.', 'invalid shape')
        const names: RawName[] = reply.names.slice(0, size + 2)
        const fresh = addCandidates(ctx, actor, p.id, round, names)
        added.push(...fresh)
        drop.push(...reply.drop)
        if (fresh.length) ctx.live.publish(p.id, { type: 'round', roundId, state: 'names', count: added.length })
        return
      } catch (e) {
        if (signal.aborted) return
        const err = e instanceof ModelError ? e : new ModelError('The naming model failed.', String(e))
        if (attempt === ATTEMPTS) errors.push(err)
      }
    }
  }
  await Promise.all(sizes.map((size, i) => ask(size, i)))
  // Parallel requests can overlap; top up once towards the full batch.
  if (!signal.aborted && added.length > 0 && added.length < count) await ask(count - added.length, sizes.length)
  return { added, drop, errors }
}

function failurePart(level: Level): string {
  return 'level:' + level
}

async function counted(
  ctx: Ctx,
  actor: Actor,
  p: ProjectRow,
  roundId: string,
  work: (signal: AbortSignal) => Promise<RoundResult>,
): Promise<RoundResult> {
  const controller = new AbortController()
  active.set(roundId, { controller, owner: actor.account?.id ?? actor.deviceId })
  try {
    await queue.enter(controller.signal, (place) => ctx.live.publish(p.id, { type: 'round', roundId, state: 'queued', place }))
  } catch {
    active.delete(roundId)
    return { added: [], dropped: [], cancelled: true, error: null }
  }
  ctx.live.publish(p.id, { type: 'round', roundId, state: 'running', by: author(actor) })
  try {
    return await work(controller.signal)
  } finally {
    queue.leave()
    active.delete(roundId)
    ctx.live.publish(p.id, { type: 'round', roundId, state: 'done' })
  }
}

function checkLevel(ctx: Ctx, level: Level) {
  const info = levelInfo(ctx.settings, unavailableParts(ctx)).find((l) => l.level === level)!
  if (!info.available) fail(503, info.unavailableReason!, { retry: false })
  return info
}

export async function generate(ctx: Ctx, actor: Actor, p: ProjectRow, body: Record<string, unknown>) {
  const level = parseLevel(body.level)
  const roundId = typeof body.roundId === 'string' ? body.roundId.slice(0, 64) : String(Date.now())
  if (!p.description.trim()) fail(400, 'Describe the company first, in your own words.')
  const info = checkLevel(ctx, level)
  const q = quote(ctx.db, ctx.settings, actor, 'rounds', info.multiplier, info.creditCost)
  if (!q.ok) fail(402, q.gate.ranOut, { ...q.gate })
  const round = p.rounds + 1
  const subject = subjectOf(actor).key
  const result = await counted(ctx, actor, p, roundId, async (signal) => {
    const out = await runModel(
      ctx,
      actor,
      p,
      level,
      { kind: 'generate', description: p.description, industry: p.industry, style: styleOf(p) },
      info.batch,
      round,
      roundId,
      signal,
    )
    if (signal.aborted) return { added: out.added, dropped: [], cancelled: true, error: null }
    if (out.errors.length) {
      const e = out.errors[0]
      ctx.alerts.failed(failurePart(level), 'generate', subject, e.reason, e.message)
    } else ctx.alerts.succeeded(failurePart(level), subject)
    if (!out.added.length) {
      const reason = out.errors[0]?.reason ?? 'The naming model returned no new names.'
      return { added: [], dropped: [], cancelled: false, error: `${reason} Nothing was taken from your allowance. Try again.` }
    }
    return { added: out.added, dropped: [], cancelled: false, error: null }
  })
  // A round that produced names is counted, unless the person cancelled it.
  if (result.added.length && !result.cancelled) {
    charge(ctx.db, ctx.settings, actor, q.payment, p.id)
    run(ctx.db, 'update projects set rounds = ? where id = ?', round, p.id)
  }
  if (result.error) fail(502, result.error, { retry: true })
  return { ...result, paid: result.cancelled || !result.added.length ? null : q.payment }
}

export async function revise(ctx: Ctx, actor: Actor, p: ProjectRow, body: Record<string, unknown>) {
  const level = parseLevel(body.level)
  const roundId = typeof body.roundId === 'string' ? body.roundId.slice(0, 64) : String(Date.now())
  const text = typeof body.direction === 'string' ? body.direction.slice(0, 2000) : ''
  const avoid = typeof body.avoid === 'string' ? body.avoid.slice(0, 1000) : ''
  const buildOnIds = Array.isArray(body.buildOn) ? body.buildOn.filter((x): x is string => typeof x === 'string') : []
  if (!text.trim() && !avoid.trim() && !buildOnIds.length) fail(400, 'Give a direction: a sentence, names to build on, or qualities to avoid.')
  checkLevel(ctx, level)
  const q = quote(ctx.db, ctx.settings, actor, 'revisions', 1, 0)
  if (!q.ok) fail(402, q.gate.ranOut, { ...q.gate })
  const all = candidates(ctx, p.id)
  const live = all.filter((c) => c.status === 'candidate' || c.status === 'kept')
  const buildOn = buildOnIds.map((cid) => candidate(ctx, p.id, cid).name)
  const round = p.rounds + 1
  const subject = subjectOf(actor).key
  const count = Math.max(5, Math.round(ctx.settings.num('round.batch') / 2))
  const result = await counted(ctx, actor, p, roundId, async (signal) => {
    const out = await runModel(
      ctx,
      actor,
      p,
      level,
      {
        kind: 'revise',
        description: p.description,
        industry: p.industry,
        style: styleOf(p),
        kept: live.filter((c) => c.status === 'kept').map((c) => c.name),
        current: live.map((c) => c.name),
        direction: { text, buildOn, avoid },
      },
      count,
      round,
      roundId,
      signal,
    )
    if (signal.aborted) return { added: out.added, dropped: [], cancelled: true, error: null }
    if (out.errors.length) ctx.alerts.failed(failurePart(level), 'revise', subject, out.errors[0].reason, out.errors[0].message)
    else ctx.alerts.succeeded(failurePart(level), subject)
    if (!out.added.length) {
      const reason = out.errors[0]?.reason ?? 'The naming model returned no new names.'
      return { added: [], dropped: [], cancelled: false, error: `${reason} Nothing was taken from your allowance. Try again.` }
    }
    // Names the direction removes leave the list. A kept name stays unless
    // the direction names it.
    const dropKeys = new Set(out.drop.map((d) => d.toLowerCase()))
    const dropped: string[] = []
    for (const c of live) {
      if (!dropKeys.has(c.name.toLowerCase())) continue
      if (c.status === 'kept' && !text.toLowerCase().includes(c.name.toLowerCase())) continue
      run(ctx.db, "update candidates set status = 'dropped', changed_by = ? where id = ?", author(actor), c.id)
      dropped.push(c.id)
      ctx.live.publish(p.id, { type: 'candidate', candidate: candidate(ctx, p.id, c.id), by: author(actor) })
    }
    return { added: out.added, dropped, cancelled: false, error: null }
  })
  if (result.added.length && !result.cancelled) {
    charge(ctx.db, ctx.settings, actor, q.payment, p.id)
    run(ctx.db, 'update projects set rounds = ? where id = ?', round, p.id)
  }
  if (result.error) fail(502, result.error, { retry: true })
  return { ...result, round }
}

// Check the .com domain of one name or a whole shortlist. Each name keeps its
// own outcome. Names that cannot form a domain, and names with a fresh taken
// result, spend nothing; a lookup that gives no answer spends nothing.
export async function checkDomains(ctx: Ctx, actor: Actor, p: ProjectRow, ids: string[]) {
  if (unavailableParts(ctx).has('lookup')) fail(503, 'Domain checks are not available right now. Try again later.', { retry: false })
  const list = ids.map((cid) => candidate(ctx, p.id, cid))
  if (!list.length) fail(400, 'Pick at least one name to check.')
  const fresh = ctx.settings.num('domain.freshnessMinutes') * 60_000
  const now = Date.now()
  const plan: { c: Candidate; domain: string }[] = []
  const results: Candidate[] = []
  for (const c of list) {
    const s = spellDomain(c.name, TLD)
    if (!s.ok) {
      results.push(setDomain(ctx, p.id, c.id, null, 'not valid', s.reason, now))
      continue
    }
    if (!(await ctx.knownTld(TLD))) {
      results.push(setDomain(ctx, p.id, c.id, null, 'not valid', `.${TLD} is not in the list of top level domains.`, now))
      continue
    }
    if (c.domainStatus === 'taken' && c.domain === s.domain && c.checkedAt && now - c.checkedAt < fresh) {
      results.push(c)
      continue
    }
    plan.push({ c, domain: s.domain })
  }
  // A shortlist that maps two names to one domain costs one check.
  const domains = [...new Set(plan.map((x) => x.domain))]
  const reconfirm = new Set(
    plan.filter((x) => x.c.domainStatus === 'available' && x.c.checkedAt && now - x.c.checkedAt < fresh).map((x) => x.domain),
  )
  const counted = domains.filter((d) => !reconfirm.has(d)).length
  if (counted) {
    const q = quote(ctx.db, ctx.settings, actor, 'checks', counted, 0)
    if (!q.ok) fail(402, q.gate.ranOut, { ...q.gate })
  }
  const subject = subjectOf(actor).key
  let settled = 0
  let unknown = 0
  await Promise.all(
    domains.map(async (domain) => {
      const r = await ctx.checker.check(domain)
      if (r.status === 'unknown') unknown++
      else if (!reconfirm.has(domain)) settled++
      for (const x of plan.filter((y) => y.domain === domain)) {
        results.push(setDomain(ctx, p.id, x.c.id, domain, r.status, r.reason, r.checkedAt))
      }
    }),
  )
  if (unknown) ctx.alerts.failed('lookup', 'check', subject, 'Lookups gave no answer', `${unknown} of ${domains.length} lookups unknown`)
  else if (domains.length) ctx.alerts.succeeded('lookup', subject)
  if (settled) charge(ctx.db, ctx.settings, actor, { counter: 'checks', amount: settled, credits: 0 }, p.id)
  return { results, spent: settled, project: toProject(ctx, p) }
}
