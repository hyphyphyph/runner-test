// Browser-local projects for a person who has not signed in.
//
// Each project is one self-contained JSON document under its own storage key.
// Reading a project, changing it or deleting it never touches another
// project's key, which is what keeps candidates, notes and results from
// mixing when the person switches projects.
//
// The store has no dependency on `window` or on the DOM, so the unit tests
// open it with an in-memory storage and a fixed clock.

import type {
  AnonymousIdentity,
  AnonymousUsage,
  Candidate,
  CandidateEnding,
  DomainStatus,
  KeyValueStorage,
  NewCandidate,
  NewDomainResult,
  NewNote,
  NewPendingCheck,
  Note,
  PendingCheck,
  Project,
  ProjectPatch,
  ProjectSummary,
  ProjectUsage,
  RejectedName,
  StyleChoices,
  UsageDelta,
} from './types.ts'

/** The default namespace. A future account store can use its own prefix. */
export const ANONYMOUS_STORAGE_PREFIX = 'nametempest.anonymous.v1'

const FORMAT = 1

export type WorkspaceErrorCode =
  | 'project_not_found'
  | 'name_required'
  | 'candidate_name_required'
  | 'candidate_duplicate'
  | 'note_required'
  | 'ending_invalid'
  | 'endings_too_many'
  | 'status_invalid'
  | 'usage_invalid'
  | 'storage_failed'

/** A refused operation in the browser-local workspace. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
  }
}

export interface WorkspaceOptions {
  storage: KeyValueStorage
  /** The current time in milliseconds. Defaults to Date.now. */
  now?: () => number
  /** Makes a new id. Defaults to a random UUID. */
  newId?: () => string
  /** The storage namespace. Defaults to ANONYMOUS_STORAGE_PREFIX. */
  prefix?: string
}

export interface NewProject {
  name?: string
  description?: string
  industry?: string
  style?: Partial<StyleChoices>
}

interface StoredIdentity {
  format: number
  identity: AnonymousIdentity
}

interface StoredProject {
  format: number
  identityId: string
  project: Project
}

interface ProjectIndex {
  format: number
  ids: string[]
}

interface ActiveDocument {
  format: number
  id: string | null
}

const EMPTY_STYLE: StyleChoices = {
  namingStyle: '',
  tone: '',
  length: '',
  include: '',
  avoid: '',
  preferredEndings: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function defaultNewId(): string {
  const source = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function clampAnchorDay(day: number): number {
  if (!Number.isInteger(day)) return 1
  return Math.min(31, Math.max(1, day))
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`
}

/**
 * The allowance period that contains `now`, given the day of the month on
 * which the person first visited. The period begins on that day each month,
 * clamped to the last day of a shorter month.
 *
 * The returned key is the year and month the period began in.
 */
export function allowancePeriod(now: number, anchorDay: number): string {
  const anchor = clampAnchorDay(anchorDay)
  const date = new Date(now)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  const thisAnchor = Math.min(anchor, lastDayOfMonth(year, month))

  if (day >= thisAnchor) return monthKey(year, month)

  const previousMonth = month === 0 ? 11 : month - 1
  const previousYear = month === 0 ? year - 1 : year
  return monthKey(previousYear, previousMonth)
}

function emptyUsage(period: string, now: number): AnonymousUsage {
  return { period, rounds: 0, revisions: 0, checks: 0, updatedAt: now }
}

function emptyProjectUsage(now: number): ProjectUsage {
  return { rounds: 0, revisions: 0, checks: 0, credits: 0, updatedAt: now }
}

function normalizeName(value: string, code: WorkspaceErrorCode, message: string): string {
  const name = value.trim()
  if (name.length === 0) throw new WorkspaceError(code, message)
  return name
}

/** Endings are bare lower-case labels, never a whole domain or a dotted form. */
function normalizeEnding(value: string): string {
  const ending = value.trim().toLowerCase().replace(/^\.+/, '')
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(ending)) {
    throw new WorkspaceError('ending_invalid', 'An ending must be a bare lower-case label, such as com.')
  }
  return ending
}

function normalizeEndings(values: readonly string[]): string[] {
  const result: string[] = []
  for (const value of values) {
    const ending = normalizeEnding(value)
    if (!result.includes(ending)) result.push(ending)
  }
  return result
}

function normalizeSuggestedEndings(values: readonly CandidateEnding[]): CandidateEnding[] {
  if (values.length > 5) {
    throw new WorkspaceError('endings_too_many', 'A name may carry at most five suggested endings.')
  }
  const result: CandidateEnding[] = []
  for (const value of values) {
    const ending = normalizeEnding(value.ending)
    if (result.some((item) => item.ending === ending)) continue
    result.push({ ending, reason: value.reason ?? '' })
  }
  return result
}

function normalizeStylePatch(style: Partial<StyleChoices> | undefined, current: StyleChoices): StyleChoices {
  const next: StyleChoices = {
    namingStyle: style?.namingStyle ?? current.namingStyle,
    tone: style?.tone ?? current.tone,
    length: style?.length ?? current.length,
    include: style?.include ?? current.include,
    avoid: style?.avoid ?? current.avoid,
    preferredEndings:
      style?.preferredEndings === undefined ? [...current.preferredEndings] : normalizeEndings(style.preferredEndings),
  }
  return next
}

function normalizeUsageDelta(delta: UsageDelta): Required<UsageDelta> {
  const fields: Array<keyof UsageDelta> = ['rounds', 'revisions', 'checks', 'credits']
  const result: Required<UsageDelta> = { rounds: 0, revisions: 0, checks: 0, credits: 0 }
  for (const field of fields) {
    const value = delta[field] ?? 0
    if (!Number.isInteger(value) || value < 0) {
      throw new WorkspaceError('usage_invalid', `A usage amount must be a positive whole number or zero.`)
    }
    result[field] = value
  }
  return result
}

function isAnonymousUsage(value: unknown): value is AnonymousUsage {
  if (!isRecord(value)) return false
  return (
    typeof value.period === 'string' &&
    typeof value.rounds === 'number' &&
    typeof value.revisions === 'number' &&
    typeof value.checks === 'number' &&
    typeof value.updatedAt === 'number'
  )
}

function isStyleChoices(value: unknown): value is StyleChoices {
  if (!isRecord(value)) return false
  return (
    typeof value.namingStyle === 'string' &&
    typeof value.tone === 'string' &&
    typeof value.length === 'string' &&
    typeof value.include === 'string' &&
    typeof value.avoid === 'string' &&
    Array.isArray(value.preferredEndings) &&
    value.preferredEndings.every((ending) => typeof ending === 'string')
  )
}

function isCandidate(value: unknown): value is Candidate {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.styleTag === 'string' &&
    Array.isArray(value.suggestedEndings) &&
    value.suggestedEndings.every(
      (ending) => isRecord(ending) && typeof ending.ending === 'string' && typeof ending.reason === 'string',
    ) &&
    typeof value.roundNumber === 'number' &&
    typeof value.createdAt === 'number'
  )
}

function isDomainResult(value: unknown): value is Project['domainResults'][number] {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.candidateId === null || typeof value.candidateId === 'string') &&
    typeof value.name === 'string' &&
    typeof value.ending === 'string' &&
    typeof value.status === 'string' &&
    ['available', 'taken', 'unknown', 'not_valid'].includes(value.status) &&
    typeof value.reason === 'string' &&
    typeof value.checkedAt === 'number'
  )
}

function isPendingCheck(value: unknown): value is Project['pendingChecks'][number] {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.candidateId === null || typeof value.candidateId === 'string') &&
    typeof value.name === 'string' &&
    typeof value.ending === 'string' &&
    typeof value.status === 'string' &&
    ['pending', 'running', 'done', 'stopped', 'failed'].includes(value.status) &&
    typeof value.requestedAt === 'number'
  )
}

function isRejectedName(value: unknown): value is Project['rejectedNames'][number] {
  return isRecord(value) && typeof value.name === 'string' && typeof value.rejectedAt === 'number'
}

function isNote(value: unknown): value is Note {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.body === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  )
}

function isProjectUsage(value: unknown): value is ProjectUsage {
  if (!isRecord(value)) return false
  return (
    typeof value.rounds === 'number' &&
    typeof value.revisions === 'number' &&
    typeof value.checks === 'number' &&
    typeof value.credits === 'number' &&
    typeof value.updatedAt === 'number'
  )
}

function isIdentity(value: unknown): value is AnonymousIdentity {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.createdAt === 'number' &&
    typeof value.allowanceAnchorDay === 'number' &&
    Number.isInteger(value.allowanceAnchorDay) &&
    value.allowanceAnchorDay >= 1 &&
    value.allowanceAnchorDay <= 31 &&
    isAnonymousUsage(value.usage)
  )
}

/** Read only the fields the store needs, so one damaged project is skipped. */
function isProject(value: unknown): value is Project {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.industry === 'string' &&
    isStyleChoices(value.style) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isCandidate) &&
    Array.isArray(value.rejectedNames) &&
    value.rejectedNames.every(isRejectedName) &&
    Array.isArray(value.notes) &&
    value.notes.every(isNote) &&
    Array.isArray(value.domainResults) &&
    value.domainResults.every(isDomainResult) &&
    Array.isArray(value.pendingChecks) &&
    value.pendingChecks.every(isPendingCheck) &&
    isProjectUsage(value.usage) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  )
}

/**
 * The browser-local workspace: one anonymous identity and any number of
 * independent projects, all held in a Web Storage compatible object.
 */
export class BrowserWorkspace {
  readonly #storage: KeyValueStorage
  readonly #now: () => number
  readonly #newId: () => string
  readonly #prefix: string

  constructor(options: WorkspaceOptions) {
    this.#storage = options.storage
    this.#now = options.now ?? Date.now
    this.#newId = options.newId ?? defaultNewId
    this.#prefix = options.prefix ?? ANONYMOUS_STORAGE_PREFIX
  }

  /** The storage key of one project. Exposed so a test can inspect deletion. */
  storageKeyForProject(id: string): string {
    return `${this.#prefix}.project.${id}`
  }

  // ---- identity ---------------------------------------------------------

  /**
   * The anonymous identity of this browser. It is made on first use and kept
   * across visits. It holds no email address and no password.
   */
  identity(): AnonymousIdentity {
    const stored = this.#readIdentity()
    const now = this.#now()

    if (stored === null) {
      const anchorDay = new Date(now).getUTCDate()
      const created: AnonymousIdentity = {
        id: this.#newId(),
        createdAt: now,
        allowanceAnchorDay: clampAnchorDay(anchorDay),
        usage: emptyUsage(allowancePeriod(now, anchorDay), now),
      }
      this.#writeIdentity(created)
      return clone(created)
    }

    const period = allowancePeriod(now, stored.allowanceAnchorDay)
    if (stored.usage.period !== period) {
      stored.usage = emptyUsage(period, now)
      this.#writeIdentity(stored)
    }

    return clone(stored)
  }

  // ---- projects ---------------------------------------------------------

  /** Every project in this browser, in the order the person sees them. */
  listProjects(): ProjectSummary[] {
    const identity = this.identity()
    return this.#readIndex()
      .map((id) => this.#readProject(id, identity.id))
      .filter((project): project is Project => project !== null)
      .map((project) => this.#summarize(project))
  }

  /** One project, or null when it does not exist in this browser. */
  project(id: string): Project | null {
    const identity = this.identity()
    const project = this.#readProject(id, identity.id)
    return project === null ? null : clone(project)
  }

  /** Make a project and make it the one on screen. */
  createProject(input: NewProject = {}): Project {
    const identity = this.identity()
    const now = this.#now()
    const name =
      input.name === undefined
        ? this.#nextDefaultName()
        : normalizeName(input.name, 'name_required', 'A project needs a name.')

    const project: Project = {
      id: this.#newId(),
      name,
      description: input.description ?? '',
      industry: input.industry ?? '',
      style: normalizeStylePatch(input.style, { ...EMPTY_STYLE, preferredEndings: [] }),
      candidates: [],
      rejectedNames: [],
      notes: [],
      domainResults: [],
      pendingChecks: [],
      usage: emptyProjectUsage(now),
      createdAt: now,
      updatedAt: now,
    }

    const index = this.#readIndex()
    const nextIndex = [...index, project.id]
    const previousActive = this.#readActive()
    try {
      this.#writeProject(project, identity.id)
      this.#writeIndex(nextIndex)
      this.#writeActive(project.id)
    } catch (error) {
      try {
        this.#storage.removeItem(this.storageKeyForProject(project.id))
      } catch {
        // The original storage error is the useful one.
      }
      try {
        this.#writeIndex(index)
      } catch {
        // The original storage error is the useful one.
      }
      try {
        this.#writeActive(previousActive)
      } catch {
        // The original storage error is the useful one.
      }
      throw new WorkspaceError('storage_failed', 'The project could not be saved in this browser.')
    }

    return clone(project)
  }

  /** Change a project's name. The owner of a shared project does this later. */
  renameProject(id: string, name: string): Project {
    const clean = normalizeName(name, 'name_required', 'A project needs a name.')
    return this.#changeProject(id, (project, now) => {
      project.name = clean
      project.updatedAt = now
    })
  }

  /** Change the company inputs or the style. Existing names stay untouched. */
  updateProject(id: string, patch: ProjectPatch): Project {
    return this.#changeProject(id, (project, now) => {
      if (patch.description !== undefined) project.description = patch.description
      if (patch.industry !== undefined) project.industry = patch.industry
      if (patch.style !== undefined) project.style = normalizeStylePatch(patch.style, project.style)
      project.updatedAt = now
    })
  }

  /**
   * Delete one project and every piece of work inside it. The other projects
   * in the browser are never touched.
   */
  deleteProject(id: string): boolean {
    const index = this.#readIndex()
    if (!index.includes(id)) return false

    // Remove the contents first. If the index write then failed, the project
    // would still be unreachable, and no work could leak back into the list.
    this.#storage.removeItem(this.storageKeyForProject(id))

    const nextIndex = index.filter((entry) => entry !== id)
    this.#writeIndex(nextIndex)

    const active = this.#readActive()
    if (active === id) {
      if (nextIndex.length === 0) {
        this.#writeActive(null)
      } else {
        const removedAt = index.indexOf(id)
        const fallback = nextIndex[Math.min(removedAt, nextIndex.length - 1)] ?? null
        this.#writeActive(fallback)
      }
    }

    // If the identity was recreated while old keys remained, deleting the
    // project still removes its key above.
    return true
  }

  // ---- the project on screen -------------------------------------------

  /** The id of the project on screen, or null when the browser has none. */
  activeProjectId(): string | null {
    const index = this.#readIndex()
    const active = this.#readActive()
    if (active !== null && index.includes(active)) return active
    return index[0] ?? null
  }

  /** The project on screen, or null when there is none. */
  activeProject(): Project | null {
    const id = this.activeProjectId()
    return id === null ? null : this.project(id)
  }

  /** Put one existing project on screen. Null clears the selection. */
  setActiveProject(id: string | null): void {
    if (id !== null && this.project(id) === null) {
      throw new WorkspaceError('project_not_found', 'That project is not in this browser.')
    }
    this.#writeActive(id)
  }

  // ---- stored work inside one project ----------------------------------

  /** Add a candidate. A name already in the project is refused. */
  addCandidate(id: string, input: NewCandidate): Project {
    const name = normalizeName(input.name, 'candidate_name_required', 'A candidate needs a name.')
    const endings = normalizeSuggestedEndings(input.suggestedEndings ?? [])

    return this.#changeProject(id, (project, now) => {
      if (project.candidates.some((candidate) => candidate.name.toLowerCase() === name.toLowerCase())) {
        throw new WorkspaceError('candidate_duplicate', 'That name is already in this project.')
      }
      const candidate: Candidate = {
        id: this.#newId(),
        name,
        reason: input.reason ?? '',
        styleTag: input.styleTag ?? '',
        suggestedEndings: endings,
        roundNumber: input.roundNumber ?? 1,
        createdAt: now,
      }
      project.candidates.push(candidate)
      project.updatedAt = now
    })
  }

  /** Record a rejected name. It stays in this project's rejected list. */
  rejectName(id: string, name: string): Project {
    const clean = normalizeName(name, 'name_required', 'A rejected name cannot be empty.')
    return this.#changeProject(id, (project, now) => {
      if (!project.rejectedNames.some((entry) => entry.name.toLowerCase() === clean.toLowerCase())) {
        const rejected: RejectedName = { name: clean, rejectedAt: now }
        project.rejectedNames.push(rejected)
      }
      project.updatedAt = now
    })
  }

  /** Take a name off the rejected list, so a later round may suggest it again. */
  unrejectName(id: string, name: string): Project {
    const clean = name.trim()
    return this.#changeProject(id, (project, now) => {
      project.rejectedNames = project.rejectedNames.filter(
        (entry) => entry.name.toLowerCase() !== clean.toLowerCase(),
      )
      project.updatedAt = now
    })
  }

  /** Add a note on a name. More than one note on one name is allowed. */
  addNote(id: string, input: NewNote): Project {
    const name = normalizeName(input.name, 'name_required', 'A note needs a name to belong to.')
    if (input.body.trim().length === 0) {
      throw new WorkspaceError('note_required', 'A note cannot be empty.')
    }
    return this.#changeProject(id, (project, now) => {
      const note: Note = {
        id: this.#newId(),
        name,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      }
      project.notes.push(note)
      project.updatedAt = now
    })
  }

  /** Replace the body of one existing note. */
  updateNote(id: string, noteId: string, body: string): Project {
    if (body.trim().length === 0) {
      throw new WorkspaceError('note_required', 'A note cannot be empty.')
    }
    return this.#changeProject(id, (project, now) => {
      const note = project.notes.find((entry) => entry.id === noteId)
      if (note === undefined) throw new WorkspaceError('project_not_found', 'That note is not in this project.')
      note.body = body
      note.updatedAt = now
      project.updatedAt = now
    })
  }

  /** Delete one note from a project. */
  deleteNote(id: string, noteId: string): Project {
    return this.#changeProject(id, (project, now) => {
      project.notes = project.notes.filter((entry) => entry.id !== noteId)
      project.updatedAt = now
    })
  }

  /** Keep one domain answer for one name and ending pair. */
  addDomainResult(id: string, input: NewDomainResult): Project {
    const name = normalizeName(input.name, 'name_required', 'A domain result needs a name.')
    const ending = normalizeEnding(input.ending)
    if (!['available', 'taken', 'unknown', 'not_valid'].includes(input.status)) {
      throw new WorkspaceError('status_invalid', 'A domain result needs a known status.')
    }
    return this.#changeProject(id, (project, now) => {
      const candidateId =
        input.candidateId === undefined
          ? (project.candidates.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())?.id ?? null)
          : input.candidateId
      if (candidateId !== null && !project.candidates.some((candidate) => candidate.id === candidateId)) {
        throw new WorkspaceError('project_not_found', 'That candidate is not in this project.')
      }
      project.domainResults.push({
        id: this.#newId(),
        candidateId,
        name,
        ending,
        status: input.status as DomainStatus,
        reason: input.reason ?? '',
        checkedAt: input.checkedAt ?? now,
      })
      project.updatedAt = now
    })
  }

  /** Tick a name and ending pair, whether or not its check has run. */
  addPendingCheck(id: string, input: NewPendingCheck): Project {
    const name = normalizeName(input.name, 'name_required', 'A pending check needs a name.')
    const ending = normalizeEnding(input.ending)
    return this.#changeProject(id, (project, now) => {
      const candidateId =
        input.candidateId === undefined
          ? (project.candidates.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())?.id ?? null)
          : input.candidateId
      if (candidateId !== null && !project.candidates.some((candidate) => candidate.id === candidateId)) {
        throw new WorkspaceError('project_not_found', 'That candidate is not in this project.')
      }

      const existing = project.pendingChecks.find(
        (entry) =>
          entry.name.toLowerCase() === name.toLowerCase() && entry.ending === ending,
      )
      if (existing !== undefined) {
        existing.status = 'pending'
        existing.requestedAt = input.requestedAt ?? now
        existing.candidateId = candidateId
      } else {
        const check: PendingCheck = {
          id: this.#newId(),
          candidateId,
          name,
          ending,
          status: 'pending',
          requestedAt: input.requestedAt ?? now,
        }
        project.pendingChecks.push(check)
      }
      project.updatedAt = now
    })
  }

  /** Remove a tick without touching any earned result. */
  removePendingCheck(id: string, name: string, ending: string): Project {
    const cleanName = name.trim().toLowerCase()
    const cleanEnding = normalizeEnding(ending)
    return this.#changeProject(id, (project, now) => {
      project.pendingChecks = project.pendingChecks.filter(
        (entry) => !(entry.name.toLowerCase() === cleanName && entry.ending === cleanEnding),
      )
      project.updatedAt = now
    })
  }

  /**
   * Add counted work to one project and to the browser identity. Moving to a
   * new allowance period resets the identity counters and never the project's
   * own usage record.
   */
  recordUsage(id: string, delta: UsageDelta): Project {
    const amount = normalizeUsageDelta(delta)
    const identity = this.identity()
    const now = this.#now()
    const period = allowancePeriod(now, identity.allowanceAnchorDay)

    const updated = this.#changeProject(id, (project) => {
      project.usage.rounds += amount.rounds
      project.usage.revisions += amount.revisions
      project.usage.checks += amount.checks
      project.usage.credits += amount.credits
      project.usage.updatedAt = now
      project.updatedAt = now
    })

    const usage = identity.usage
    if (usage.period !== period) {
      identity.usage = emptyUsage(period, now)
    }
    identity.usage.rounds += amount.rounds
    identity.usage.revisions += amount.revisions
    identity.usage.checks += amount.checks
    identity.usage.updatedAt = now
    this.#writeIdentity(identity)

    return updated
  }

  // ---- internals --------------------------------------------------------

  #nextDefaultName(): string {
    const names = new Set(this.listProjects().map((project) => project.name))
    if (!names.has('Untitled project')) return 'Untitled project'
    let number = 2
    while (names.has(`Untitled project ${number}`)) number += 1
    return `Untitled project ${number}`
  }

  #summarize(project: Project): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      candidateCount: project.candidates.length,
      rejectedNameCount: project.rejectedNames.length,
      noteCount: project.notes.length,
      domainResultCount: project.domainResults.length,
      pendingCheckCount: project.pendingChecks.length,
      usage: clone(project.usage),
    }
  }

  #changeProject(
    id: string,
    change: (project: Project, now: number) => void,
  ): Project {
    const identity = this.identity()
    const project = this.#readProject(id, identity.id)
    if (project === null) {
      throw new WorkspaceError('project_not_found', 'That project is not in this browser.')
    }

    const now = this.#now()
    change(project, now)
    this.#writeProject(project, identity.id)
    return clone(project)
  }

  #readProject(id: string, identityId: string): Project | null {
    const value = parseJson(this.#storage.getItem(this.storageKeyForProject(id)))
    if (!isRecord(value) || value.format !== FORMAT) return null
    if (value.identityId !== identityId) return null
    const project = value.project
    if (!isProject(project) || project.id !== id) return null
    return project
  }

  #writeProject(project: Project, identityId: string): void {
    const document: StoredProject = { format: FORMAT, identityId, project }
    try {
      this.#storage.setItem(this.storageKeyForProject(project.id), JSON.stringify(document))
    } catch {
      throw new WorkspaceError('storage_failed', 'This browser would not save the project.')
    }
  }

  #readIdentity(): AnonymousIdentity | null {
    const value = parseJson(this.#storage.getItem(`${this.#prefix}.identity`))
    if (!isRecord(value) || value.format !== FORMAT) return null
    return isIdentity(value.identity) ? value.identity : null
  }

  #writeIdentity(identity: AnonymousIdentity): void {
    const document: StoredIdentity = { format: FORMAT, identity }
    try {
      this.#storage.setItem(`${this.#prefix}.identity`, JSON.stringify(document))
    } catch {
      throw new WorkspaceError('storage_failed', 'This browser would not save your anonymous identity.')
    }
  }

  #readIndex(): string[] {
    const value = parseJson(this.#storage.getItem(`${this.#prefix}.projects`))
    if (!isRecord(value) || value.format !== FORMAT || !Array.isArray(value.ids)) return []
    const ids: string[] = []
    for (const id of value.ids) {
      if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
    }
    return ids
  }

  #writeIndex(ids: string[]): void {
    const document: ProjectIndex = { format: FORMAT, ids }
    try {
      this.#storage.setItem(`${this.#prefix}.projects`, JSON.stringify(document))
    } catch {
      throw new WorkspaceError('storage_failed', 'This browser would not save the project list.')
    }
  }

  #readActive(): string | null {
    const value = parseJson(this.#storage.getItem(`${this.#prefix}.active`))
    if (!isRecord(value) || value.format !== FORMAT) return null
    return typeof value.id === 'string' ? value.id : null
  }

  #writeActive(id: string | null): void {
    const document: ActiveDocument = { format: FORMAT, id }
    try {
      this.#storage.setItem(`${this.#prefix}.active`, JSON.stringify(document))
    } catch {
      throw new WorkspaceError('storage_failed', 'This browser would not remember the open project.')
    }
  }
}
