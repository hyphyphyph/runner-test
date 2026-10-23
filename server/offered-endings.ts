// Build the offered endings from the public registry sources
// (DomainCheck.offeredEndings, Admin.endings).
//
// The daily job fetches two public files:
//   * the IANA root zone list, which is the universe of endings
//   * the IANA RDAP bootstrap file, which maps an ending to its registration
//     query service
//
// An ending is offered when it is in the root zone list, the bootstrap file
// gives it an RDAP service (a route that can answer both free and taken), and
// its registry terms allow a hosted product to query it. Every fact and the
// reason for a refusal are stored, so the admin interface can show them.
//
// Every other part asks this store for the offered list. There is no second
// list in code: the shipped style picks are only starting values for the
// operator's preferred-ending list and are filtered through this store.

import type { Db } from './db.ts'
import type {
  OfferedEnding,
  OfferedEndingReasonCode,
  OfferedEndingsReport,
} from '../shared/endings.ts'
import { isEnding, REQUIRED_OFFERED_ENDINGS } from '../shared/endings.ts'

/** The public root zone list published by IANA. */
export const ROOT_ZONE_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt'

/** The public RDAP bootstrap file published by IANA. */
export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'

/** The refresh is daily, as DomainCheck.registries says. */
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 20_000

/** A registry's terms decision. */
export interface RegistryTermsDecision {
  allowsHostedQueries: boolean
  /** Plain words to show when the registry is refused. */
  reason?: string | null
}

/**
 * Where the refresh learns whether a registry's terms allow hosted queries.
 *
 * There is no public machine-readable source for registry terms, so the store
 * reads a recorded `registry_terms` row and otherwise allows the shipped RDAP
 * route. A caller may inject a policy for a test or for a future terms feed.
 */
export type RegistryTermsPolicy = (ending: string) => RegistryTermsDecision | boolean

export interface OfferedEndingStoreOptions {
  /** Fixed clock, so a test can check the recorded time. */
  now?: () => Date
  /** Replaces the network fetch in a test. */
  fetch?: typeof globalThis.fetch
  rootZoneUrl?: string
  rdapBootstrapUrl?: string
  /** A terms decision source that takes precedence over the stored rows. */
  terms?: RegistryTermsPolicy
  /** How long one source request may take. */
  timeoutMs?: number
}

/** The output of one successful refresh. */
export interface OfferedEndingRefreshResult {
  fetchedAt: number
  rootZoneCount: number
  rdapRouteCount: number
  offeredCount: number
  offeredEndings: string[]
}

/** The state of the last refresh, for the status page and tests. */
export interface OfferedEndingRefreshState {
  attemptedAt: number | null
  refreshedAt: number | null
  error: string | null
}

/** A refused refresh. The last good list is left in place. */
export class OfferedEndingRefreshError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'OfferedEndingRefreshError'
    this.code = code
  }
}

/** Read a root zone list into clean endings. Throws when the list is empty. */
export function parseRootZoneList(text: string): string[] {
  const endings: string[] = []
  const seen = new Set<string>()

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const ending = line.replace(/^\.+/, '').toLowerCase()
    if (!isEnding(ending)) continue
    if (seen.has(ending)) continue
    seen.add(ending)
    endings.push(ending)
  }

  if (endings.length === 0) {
    throw new OfferedEndingRefreshError(
      'root_zone_empty',
      'The root zone list held no endings, so the offered-ending list was left as it was.',
    )
  }
  return endings
}

/**
 * Read the RDAP bootstrap file. Returns the first usable service address for
 * each ending. Throws when the file is not the expected shape.
 */
export function parseRdapBootstrap(value: unknown): Map<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OfferedEndingRefreshError(
      'rdap_bootstrap_invalid',
      'The RDAP bootstrap file was not an object, so the offered-ending list was left as it was.',
    )
  }

  const services = (value as { services?: unknown }).services
  if (!Array.isArray(services) || services.length === 0) {
    throw new OfferedEndingRefreshError(
      'rdap_bootstrap_invalid',
      'The RDAP bootstrap file held no services, so the offered-ending list was left as it was.',
    )
  }

  const routes = new Map<string, string>()
  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2) continue
    const endings = service[0]
    const addresses = service[1]
    if (!Array.isArray(endings) || !Array.isArray(addresses)) continue

    const url = addresses.find(
      (address): address is string =>
        typeof address === 'string' && /^https?:\/\/[^\s]+$/i.test(address.trim()),
    )
    if (url === undefined) continue

    for (const rawEnding of endings) {
      if (typeof rawEnding !== 'string') continue
      const ending = rawEnding.trim().replace(/^\.+/, '').toLowerCase()
      if (!isEnding(ending)) continue
      if (!routes.has(ending)) routes.set(ending, url.trim())
    }
  }

  if (routes.size === 0) {
    throw new OfferedEndingRefreshError(
      'rdap_bootstrap_invalid',
      'The RDAP bootstrap file held no usable service address, so the offered-ending list was left as it was.',
    )
  }
  return routes
}

interface OfferedEndingRow {
  ending: string
  in_root_zone: number
  route_answers_both: number
  terms_allow_hosted_queries: number
  required_by_product: number
  offered: number
  reason_code: OfferedEndingReasonCode | null
  reason: string | null
  registration_query_url: string | null
  source: string
  updated_at: number
}

interface TermsRow {
  allows_hosted_queries: number
  reason: string | null
}

interface MetaRow {
  value: string
}

/** The facts the refresh found for one ending, before the offer is decided. */
interface EndingFacts {
  ending: string
  inRootZone: boolean
  registrationQueryUrl: string | null
  terms: { allowed: boolean; reason: string | null }
}

/**
 * The offered-ending store. Every read goes to the database, so a refresh or
 * an operator decision applies to the next request.
 */
export class OfferedEndingStore {
  readonly #db: Db
  readonly #now: () => Date
  readonly #fetch: typeof globalThis.fetch
  readonly #rootZoneUrl: string
  readonly #rdapBootstrapUrl: string
  readonly #terms: RegistryTermsPolicy | undefined
  readonly #timeoutMs: number

  constructor(db: Db, options: OfferedEndingStoreOptions = {}) {
    this.#db = db
    this.#now = options.now ?? (() => new Date())
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#rootZoneUrl = options.rootZoneUrl ?? ROOT_ZONE_URL
    this.#rdapBootstrapUrl = options.rdapBootstrapUrl ?? RDAP_BOOTSTRAP_URL
    this.#terms = options.terms
    this.#timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  }

  /**
   * The one offered-endings query every other part reads. Rows are ordered by
   * ending and include the reasons behind an ending that is not offered.
   */
  report(): OfferedEndingsReport {
    const endings = this.list()
    return {
      endings,
      offeredEndings: endings.filter((ending) => ending.offered).map((ending) => ending.ending),
      refreshedAt: this.#readMetaNumber('last_success'),
    }
  }

  /** Every ending the refresh has seen, ordered by ending. */
  list(): OfferedEnding[] {
    const rows = this.#db
      .prepare(
        `select ending, in_root_zone, route_answers_both, terms_allow_hosted_queries,
                required_by_product, offered, reason_code, reason, registration_query_url,
                source, updated_at
         from offered_endings
         order by ending`,
      )
      .all() as unknown as OfferedEndingRow[]

    return rows.map(toOfferedEnding)
  }

  /** The endings that may be suggested or ticked, in order. */
  offered(): string[] {
    return this.report().offeredEndings
  }

  /**
   * True when one ending may be suggested or ticked. The answer comes only
   * from the refreshed rows, so an ending that is not in the store is not
   * offered. The one seeded `.com` row is what answers before the first
   * refresh; nothing else is assumed.
   */
  isOffered(ending: string): boolean {
    const clean = ending.trim().replace(/^\.+/, '').toLowerCase()
    if (!isEnding(clean)) return false
    const row = this.#db
      .prepare('select offered from offered_endings where ending = ?')
      .get(clean) as { offered: number } | undefined
    return row !== undefined && row.offered === 1
  }

  /** The state of the last refresh. */
  refreshState(): OfferedEndingRefreshState {
    return {
      attemptedAt: this.#readMetaNumber('last_attempt'),
      refreshedAt: this.#readMetaNumber('last_success'),
      error: this.#readMeta('last_error'),
    }
  }

  /**
   * Fetch both public files and replace the stored facts. A fetch or parse
   * failure is recorded and thrown; the last good rows stay in place.
   */
  async refresh(): Promise<OfferedEndingRefreshResult> {
    const attemptedAt = this.#now().getTime()
    this.#writeMeta('last_attempt', String(attemptedAt))

    try {
      const [rootZoneText, bootstrapText] = await Promise.all([
        this.#fetchText(this.#rootZoneUrl),
        this.#fetchText(this.#rdapBootstrapUrl),
      ])

      let bootstrap: unknown
      try {
        bootstrap = JSON.parse(bootstrapText.replace(/^\uFEFF/, ''))
      } catch (error) {
        throw new OfferedEndingRefreshError(
          'rdap_bootstrap_invalid',
          'The RDAP bootstrap file was not JSON, so the offered-ending list was left as it was.',
          { cause: error },
        )
      }

      return this.applySources({
        rootZoneText,
        rdapBootstrap: bootstrap,
        fetchedAt: this.#now().getTime(),
        source: 'refresh',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The refresh failed.'
      this.#writeMeta('last_error', message)
      this.#writeMeta('last_failure', String(attemptedAt))
      throw error
    }
  }

  /**
   * Apply already-fetched sources. This is the same path the network refresh
   * uses, so a test can exercise the full decision without a socket.
   */
  applySources(input: {
    rootZoneText: string
    rdapBootstrap: unknown
    fetchedAt?: number
    source?: string
  }): OfferedEndingRefreshResult {
    const rootEndings = parseRootZoneList(input.rootZoneText)
    const routes = parseRdapBootstrap(input.rdapBootstrap)
    const rootZone = new Set(rootEndings)
    const fetchedAt = input.fetchedAt ?? this.#now().getTime()
    const source = input.source ?? 'refresh'

    const existing = this.#db
      .prepare('select ending from offered_endings')
      .all() as Array<{ ending: string }>

    const endings = new Set<string>(existing.map((row) => row.ending))
    for (const ending of rootEndings) endings.add(ending)
    for (const ending of REQUIRED_OFFERED_ENDINGS) endings.add(ending)

    const facts: EndingFacts[] = [...endings]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map((ending) => ({
        ending,
        inRootZone: rootZone.has(ending),
        registrationQueryUrl: routes.get(ending) ?? null,
        terms: this.#termsDecision(ending),
      }))

    const upsert = this.#db.prepare(
      `insert into offered_endings
        (ending, in_root_zone, route_answers_both, terms_allow_hosted_queries,
         required_by_product, offered, reason_code, reason, registration_query_url,
         source, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(ending) do update set
         in_root_zone = excluded.in_root_zone,
         route_answers_both = excluded.route_answers_both,
         terms_allow_hosted_queries = excluded.terms_allow_hosted_queries,
         required_by_product = excluded.required_by_product,
         offered = excluded.offered,
         reason_code = excluded.reason_code,
         reason = excluded.reason,
         registration_query_url = excluded.registration_query_url,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )

    this.#transaction(() => {
      for (const fact of facts) {
        const decision = decideEnding(fact)
        upsert.run(
          decision.ending,
          decision.inRootZone ? 1 : 0,
          decision.routeAnswersBoth ? 1 : 0,
          decision.termsAllowHostedQueries ? 1 : 0,
          decision.requiredByProduct ? 1 : 0,
          decision.offered ? 1 : 0,
          decision.reasonCode,
          decision.reason,
          decision.registrationQueryUrl,
          source,
          fetchedAt,
        )
      }

      this.#writeMeta('last_attempt', String(fetchedAt))
      this.#writeMeta('last_success', String(fetchedAt))
      this.#writeMeta('last_source', source)
      this.#deleteMeta('last_error')
    })

    const offeredEndings = this.offered()
    return {
      fetchedAt,
      rootZoneCount: rootEndings.length,
      rdapRouteCount: routes.size,
      offeredCount: offeredEndings.length,
      offeredEndings,
    }
  }

  /**
   * Record a registry terms decision. The next refresh applies it. When the
   * ending already has a row, its offer is recomputed at once.
   */
  setTerms(
    ending: string,
    allowsHostedQueries: boolean,
    options: { operator: string; reason?: string | null; now?: Date },
  ): void {
    const clean = ending.trim().replace(/^\.+/, '').toLowerCase()
    if (!isEnding(clean)) {
      throw new RangeError('An ending must be a bare lower-case label, such as com.')
    }
    const operator = options.operator.trim()
    if (operator.length === 0) {
      throw new RangeError('A terms decision needs the operator who made it.')
    }
    const reason = normalizeReason(options.reason)
    const now = (options.now ?? this.#now()).getTime()

    this.#transaction(() => {
      this.#db
        .prepare(
          `insert into registry_terms
            (ending, allows_hosted_queries, reason, decided_at, decided_by)
           values (?, ?, ?, ?, ?)
           on conflict(ending) do update set
             allows_hosted_queries = excluded.allows_hosted_queries,
             reason = excluded.reason,
             decided_at = excluded.decided_at,
             decided_by = excluded.decided_by`,
        )
        .run(clean, allowsHostedQueries ? 1 : 0, reason, now, operator)

      const row = this.#db
        .prepare(
          `select ending, in_root_zone, registration_query_url
           from offered_endings where ending = ?`,
        )
        .get(clean) as
        | { ending: string; in_root_zone: number; registration_query_url: string | null }
        | undefined
      if (row === undefined) return

      const decision = decideEnding({
        ending: row.ending,
        inRootZone: row.in_root_zone === 1,
        registrationQueryUrl: row.registration_query_url,
        terms: { allowed: allowsHostedQueries, reason },
      })

      this.#db
        .prepare(
          `update offered_endings set
             terms_allow_hosted_queries = ?, offered = ?, reason_code = ?,
             reason = ?, source = 'terms', updated_at = ?
           where ending = ?`,
        )
        .run(
          decision.termsAllowHostedQueries ? 1 : 0,
          decision.offered ? 1 : 0,
          decision.reasonCode,
          decision.reason,
          now,
          clean,
        )
    })
  }

  // ---- internals --------------------------------------------------------

  async #fetchText(url: string): Promise<string> {
    let response: Response
    try {
      response = await this.#fetch(url, {
        headers: { accept: 'text/plain, application/json;q=0.9, */*;q=0.1' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      })
    } catch (error) {
      throw new OfferedEndingRefreshError(
        'source_unreachable',
        `The source ${url} could not be reached, so the offered-ending list was left as it was.`,
        { cause: error },
      )
    }

    if (!response.ok) {
      throw new OfferedEndingRefreshError(
        'source_refused',
        `The source ${url} answered with status ${response.status}, so the offered-ending list was left as it was.`,
      )
    }

    try {
      return await response.text()
    } catch (error) {
      throw new OfferedEndingRefreshError(
        'source_unreachable',
        `The source ${url} could not be read, so the offered-ending list was left as it was.`,
        { cause: error },
      )
    }
  }

  #termsDecision(ending: string): { allowed: boolean; reason: string | null } {
    if (this.#terms !== undefined) {
      try {
        const decision = this.#terms(ending)
        if (typeof decision === 'boolean') return { allowed: decision, reason: null }
        return {
          allowed: decision.allowsHostedQueries === true,
          reason: normalizeReason(decision.reason),
        }
      } catch {
        return {
          allowed: false,
          reason: 'The registry terms could not be read, so the ending is not offered.',
        }
      }
    }

    const row = this.#db
      .prepare('select allows_hosted_queries, reason from registry_terms where ending = ?')
      .get(ending) as TermsRow | undefined
    if (row === undefined) return { allowed: true, reason: null }
    return { allowed: row.allows_hosted_queries === 1, reason: normalizeReason(row.reason) }
  }

  #readMeta(key: string): string | null {
    const row = this.#db
      .prepare('select value from offered_endings_meta where key = ?')
      .get(key) as MetaRow | undefined
    return row?.value ?? null
  }

  #readMetaNumber(key: string): number | null {
    const value = this.#readMeta(key)
    if (value === null) return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  #writeMeta(key: string, value: string): void {
    this.#db
      .prepare(
        `insert into offered_endings_meta (key, value) values (?, ?)
         on conflict(key) do update set value = excluded.value`,
      )
      .run(key, value)
  }

  #deleteMeta(key: string): void {
    this.#db.prepare('delete from offered_endings_meta where key = ?').run(key)
  }

  #transaction(run: () => void): void {
    this.#db.exec('savepoint offered_ending_write')
    try {
      run()
      this.#db.exec('release offered_ending_write')
    } catch (error) {
      try {
        this.#db.exec('rollback to offered_ending_write')
        this.#db.exec('release offered_ending_write')
      } catch {
        // The original error is the useful one.
      }
      throw error
    }
  }
}

/** Decide one row from its facts and the product's required endings. */
function decideEnding(fact: EndingFacts): {
  ending: string
  inRootZone: boolean
  routeAnswersBoth: boolean
  termsAllowHostedQueries: boolean
  requiredByProduct: boolean
  offered: boolean
  reasonCode: OfferedEndingReasonCode | null
  reason: string | null
  registrationQueryUrl: string | null
} {
  const routeAnswersBoth = fact.registrationQueryUrl !== null
  const requiredByProduct = REQUIRED_OFFERED_ENDINGS.includes(fact.ending)
  // The three tests hold together. The required `.com` row is seeded before
  // the first refresh, but once the sources are read every ending, `.com`
  // included, is judged on the same three facts.
  const offered = fact.inRootZone && routeAnswersBoth && fact.terms.allowed

  let reasonCode: OfferedEndingReasonCode | null = null
  let reason: string | null = null

  if (!offered) {
    const reasons: string[] = []
    if (!fact.inRootZone) {
      reasonCode = 'not_in_root_zone'
      reasons.push('It is missing from the root zone list.')
    }
    if (!routeAnswersBoth) {
      if (reasonCode === null) reasonCode = 'route_cannot_settle'
      reasons.push('The shipped lookup chain has no route that answers both free and taken for it.')
    }
    if (!fact.terms.allowed) {
      if (reasonCode === null) reasonCode = 'terms_disallow'
      reasons.push(
        fact.terms.reason ?? 'Its registry terms do not allow a hosted product to query it at this volume.',
      )
    }
    reason = reasons.join(' ')
  }

  return {
    ending: fact.ending,
    inRootZone: fact.inRootZone,
    routeAnswersBoth,
    termsAllowHostedQueries: fact.terms.allowed,
    requiredByProduct,
    offered,
    reasonCode,
    reason,
    registrationQueryUrl: fact.registrationQueryUrl,
  }
}

function toOfferedEnding(row: OfferedEndingRow): OfferedEnding {
  return {
    ending: row.ending,
    inRootZone: row.in_root_zone === 1,
    routeAnswersBoth: row.route_answers_both === 1,
    termsAllowHostedQueries: row.terms_allow_hosted_queries === 1,
    requiredByProduct: row.required_by_product === 1,
    offered: row.offered === 1,
    reasonCode: row.reason_code,
    reason: row.reason,
    registrationQueryUrl: row.registration_query_url,
    source: row.source,
    updatedAt: row.updated_at,
  }
}

function normalizeReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const text = reason.trim()
  return text.length === 0 ? null : text
}

// ---- the daily job -------------------------------------------------------

export interface OfferedEndingRefreshOptions extends OfferedEndingStoreOptions {
  /** How often to refresh. Defaults to one day. */
  intervalMs?: number
  /** Run once as soon as the job starts. Defaults to true. */
  runImmediately?: boolean
  /** Called when a refresh fails. The default writes to the console. */
  onError?: (error: unknown) => void
}

export interface OfferedEndingRefreshJob {
  /** Stop the daily timer. A refresh already running is left to finish. */
  stop(): void
  /** Run a refresh now. Overlapping calls share the one in flight. */
  refresh(): Promise<OfferedEndingRefreshResult>
}

/**
 * Start the daily refresh. The timer is unref'd, so it never keeps a process
 * alive on its own. A failed refresh is logged and the last good list stays.
 */
export function startOfferedEndingRefresh(
  db: Db,
  options: OfferedEndingRefreshOptions = {},
): OfferedEndingRefreshJob {
  const store = new OfferedEndingStore(db, options)
  const onError = options.onError ?? ((error: unknown) => console.error('The offered-ending refresh failed.', error))
  let inFlight: Promise<OfferedEndingRefreshResult> | null = null

  const run = (): Promise<OfferedEndingRefreshResult> => {
    if (inFlight !== null) return inFlight
    inFlight = store.refresh().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const runQuietly = (): void => {
    void run().catch((error: unknown) => onError(error))
  }

  const interval = options.intervalMs ?? REFRESH_INTERVAL_MS
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError('The offered-ending refresh interval must be a positive number of milliseconds.')
  }

  if (options.runImmediately !== false) runQuietly()

  const timer = setInterval(runQuietly, interval)
  timer.unref()

  return {
    stop(): void {
      clearInterval(timer)
    },
    refresh(): Promise<OfferedEndingRefreshResult> {
      return run()
    },
  }
}
