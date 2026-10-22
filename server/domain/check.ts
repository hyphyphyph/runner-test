// The domain check (DomainCheck). A chain of steps ordered by speed that stops
// at the first settled answer. Only a fresh structured registration reply
// (RDAP not found) may report available; any doubt is unknown.

import type { Db } from '../db.ts'
import { one, run } from '../db.ts'

export type RdapReply = 'found' | 'notfound' | 'malformed'

export interface Sources {
  // Name servers present for the domain.
  dns(domain: string): Promise<boolean>
  // Whether the registry has a registration query service at all.
  hasRdap(tld: string): Promise<boolean>
  rdap(domain: string): Promise<RdapReply>
  whois(domain: string): Promise<'registered' | 'nomatch'>
  // A paid service, when the operator configured one.
  paid: null | ((domain: string) => Promise<'registered' | 'free'>)
}

export interface Result {
  status: 'available' | 'taken' | 'unknown'
  reason: string | null
  source: string
  checkedAt: number
}

export class LookupError extends Error {
  reason: string
  constructor(reason: string, detail?: string) {
    super(detail ?? reason)
    this.reason = reason
  }
}

export interface CheckerOptions {
  freshnessMs: () => number
  timeoutMs?: number
  concurrency?: number
  onFailure?: (step: string, reason: string, detail: string) => void
}

class Semaphore {
  private free: number
  private waiting: (() => void)[] = []
  constructor(n: number) {
    this.free = n
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--
    else await new Promise<void>((r) => this.waiting.push(r))
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.free++
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new LookupError(reason, 'timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function reasonOf(e: unknown, fallback: string): string {
  return e instanceof LookupError ? e.reason : fallback
}

export class DomainChecker {
  private db: Db
  private sources: Sources
  private opts: CheckerOptions
  private inflight = new Map<string, Promise<Result>>()
  private sem: Semaphore

  constructor(db: Db, sources: Sources, opts: CheckerOptions) {
    this.db = db
    this.sources = sources
    this.opts = opts
    this.sem = new Semaphore(opts.concurrency ?? 8)
  }

  // One lookup per domain at a time: two names that map to the same domain
  // share the answer.
  check(domain: string): Promise<Result> {
    const existing = this.inflight.get(domain)
    if (existing) return existing
    const p = this.sem
      .use(() =>
        withTimeout(this.chain(domain), this.opts.timeoutMs ?? 8000, 'The lookup took too long to answer. Try again in a moment.'),
      )
      .catch(
        (e): Result => ({
          status: 'unknown',
          reason: reasonOf(e, 'The lookup failed. Try again in a moment.'),
          source: 'none',
          checkedAt: Date.now(),
        }),
      )
      .finally(() => this.inflight.delete(domain))
    this.inflight.set(domain, p)
    return p
  }

  private cached(domain: string): { status: string; source: string; checked_at: number } | undefined {
    const row = one<{ status: string; source: string; checked_at: number }>(
      this.db,
      'select * from domain_cache where domain = ?',
      domain,
    )
    if (!row) return undefined
    if (Date.now() - row.checked_at > this.opts.freshnessMs()) return undefined
    return row
  }

  private store(domain: string, status: 'available' | 'taken', source: string): Result {
    const now = Date.now()
    run(
      this.db,
      `insert into domain_cache (domain, status, source, checked_at) values (?, ?, ?, ?)
       on conflict(domain) do update set status = excluded.status, source = excluded.source, checked_at = excluded.checked_at`,
      domain,
      status,
      source,
      now,
    )
    return { status, reason: null, source, checkedAt: now }
  }

  private fail(step: string, e: unknown): string {
    const reason = reasonOf(e, `The ${step} lookup failed.`)
    this.opts.onFailure?.(step, reason, e instanceof Error ? e.message : String(e))
    return reason
  }

  private async chain(domain: string): Promise<Result> {
    const tld = domain.slice(domain.lastIndexOf('.') + 1)
    const cached = this.cached(domain)
    // A stored taken answer is served within the freshness window.
    if (cached?.status === 'taken') {
      return { status: 'taken', reason: null, source: cached.source + ' (stored)', checkedAt: cached.checked_at }
    }
    const reasons: string[] = []

    // Step 1: name servers. A stored available result stands in for this
    // step, never for the fresh confirmation below.
    if (cached?.status !== 'available') {
      try {
        if (await this.sources.dns(domain)) return this.store(domain, 'taken', 'dns')
      } catch (e) {
        reasons.push(this.fail('dns', e))
      }
    }

    // Step 2: the registration query, run fresh every time.
    try {
      if (await this.sources.hasRdap(tld)) {
        const reply = await this.sources.rdap(domain)
        if (reply === 'found') return this.store(domain, 'taken', 'rdap')
        if (reply === 'notfound') return this.store(domain, 'available', 'rdap')
        reasons.push('The registry answered in a shape we could not read, so the result is not known.')
        this.opts.onFailure?.('rdap', 'malformed reply', domain)
      } else {
        reasons.push('This registry has no registration query service, so a free name cannot be confirmed.')
      }
    } catch (e) {
      reasons.push(this.fail('rdap', e))
    }

    // Step 3: WHOIS, only when RDAP is missing or failed. It can prove a name
    // taken but, as an unstructured reply, never that it is free.
    try {
      const w = await this.sources.whois(domain)
      if (w === 'registered') return this.store(domain, 'taken', 'whois')
      reasons.push('Only the registration query can confirm that a name is free, and it did not answer.')
    } catch (e) {
      reasons.push(this.fail('whois', e))
    }

    // Step 4: a paid service, only when the operator configured one. Like
    // WHOIS it can settle taken, never available.
    if (this.sources.paid) {
      try {
        const p = await this.sources.paid(domain)
        if (p === 'registered') return this.store(domain, 'taken', 'paid')
      } catch (e) {
        reasons.push(this.fail('paid', e))
      }
    }

    return {
      status: 'unknown',
      reason: reasons[0] ?? 'No answer is known right now. Try again in a moment.',
      source: 'none',
      checkedAt: Date.now(),
    }
  }
}
