// Projects, candidates and notes (Projects, Candidate, SharedProjects,
// StoredWork.scope). A project is visible to its owner, to the members of the
// organization it is shared with, and to nobody else.

import type { Ctx } from './context.ts'
import { all, id, one, run, tx } from './db.ts'
import type { Actor } from './allowance.ts'
import { fail } from './http.ts'
import { nameKey } from './model.ts'
import type { Candidate, CandidateStatus, Note, Project, ProjectDetail, Style } from '../shared/types.ts'
import { EMPTY_STYLE } from '../shared/types.ts'

export interface ProjectRow {
  id: string
  device_id: string | null
  account_id: string | null
  org_id: string | null
  shared: number
  name: string
  description: string
  industry: string
  style: string
  rounds: number
  used_rounds: number
  used_revisions: number
  used_checks: number
  used_credits: number
  conflict_with: string | null
  offered_from: string | null
  created_at: number
  updated_at: number
}

interface CandidateRow {
  id: string
  project_id: string
  name: string
  reason: string
  style: string
  domain: string | null
  domain_status: string
  domain_reason: string | null
  checked_at: number | null
  status: string
  round: number
  added_by: string | null
  changed_by: string | null
  created_at: number
}

interface NoteRow {
  id: string
  project_id: string
  candidate_id: string | null
  body: string
  author: string | null
  version: number
  conflict_of: string | null
  updated_at: number
}

export function canSee(actor: Actor, p: ProjectRow): boolean {
  if (actor.account) {
    if (p.account_id === actor.account.id) return true
    return p.shared === 1 && !!p.org_id && actor.org?.id === p.org_id && actor.org.plan_active === 1
  }
  return p.account_id === null && p.device_id === actor.deviceId
}

export function author(actor: Actor): string | null {
  return actor.account?.email ?? null
}

export function getProject(ctx: Ctx, actor: Actor, projectId: string): ProjectRow {
  const p = one<ProjectRow>(ctx.db, 'select * from projects where id = ?', projectId)
  if (!p || !canSee(actor, p)) fail(404, 'This project does not exist, or you cannot see it.')
  return p
}

function parseStyle(raw: string): Style {
  try {
    return { ...EMPTY_STYLE, ...JSON.parse(raw) }
  } catch {
    return { ...EMPTY_STYLE }
  }
}

export function toProject(ctx: Ctx, p: ProjectRow): Project {
  const owner = p.account_id ? one<{ email: string }>(ctx.db, 'select email from accounts where id = ?', p.account_id) : null
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    industry: p.industry,
    style: parseStyle(p.style),
    shared: p.shared === 1,
    orgId: p.org_id,
    ownerLabel: owner?.email ?? null,
    rounds: p.rounds,
    usage: { rounds: p.used_rounds, revisions: p.used_revisions, checks: p.used_checks, credits: p.used_credits },
    conflictWith: p.conflict_with,
    offeredFrom: p.offered_from,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }
}

export function toCandidate(c: CandidateRow): Candidate {
  return {
    id: c.id,
    projectId: c.project_id,
    name: c.name,
    reason: c.reason,
    style: c.style,
    domain: c.domain,
    domainStatus: c.domain_status as Candidate['domainStatus'],
    domainReason: c.domain_reason,
    checkedAt: c.checked_at,
    status: c.status as CandidateStatus,
    round: c.round,
    addedBy: c.added_by,
    changedBy: c.changed_by,
    createdAt: c.created_at,
  }
}

function toNote(n: NoteRow): Note {
  return {
    id: n.id,
    projectId: n.project_id,
    candidateId: n.candidate_id,
    body: n.body,
    author: n.author,
    version: n.version,
    conflictOf: n.conflict_of,
    updatedAt: n.updated_at,
  }
}

export function candidates(ctx: Ctx, projectId: string): Candidate[] {
  return all<CandidateRow>(ctx.db, 'select * from candidates where project_id = ? order by created_at, rowid', projectId).map(toCandidate)
}

export function candidate(ctx: Ctx, projectId: string, candidateId: string): Candidate {
  const c = one<CandidateRow>(ctx.db, 'select * from candidates where id = ? and project_id = ?', candidateId, projectId)
  if (!c) fail(404, 'That name is not in this project.')
  return toCandidate(c)
}

export function detail(ctx: Ctx, actor: Actor, p: ProjectRow): ProjectDetail {
  return {
    ...toProject(ctx, p),
    candidates: candidates(ctx, p.id),
    notes: all<NoteRow>(ctx.db, 'select * from notes where project_id = ? order by updated_at', p.id).map(toNote),
    canShare: !!actor.org && actor.org.plan_active === 1 && p.account_id === actor.account?.id,
  }
}

export function listProjects(ctx: Ctx, actor: Actor): Project[] {
  let rows: ProjectRow[]
  if (actor.account) {
    rows = actor.org
      ? all<ProjectRow>(
          ctx.db,
          'select * from projects where account_id = ? or (shared = 1 and org_id = ?) order by updated_at desc',
          actor.account.id,
          actor.org.plan_active ? actor.org.id : '-',
        )
      : all<ProjectRow>(ctx.db, 'select * from projects where account_id = ? order by updated_at desc', actor.account.id)
  } else {
    rows = all<ProjectRow>(ctx.db, 'select * from projects where account_id is null and device_id = ? order by updated_at desc', actor.deviceId)
  }
  return rows.map((p) => toProject(ctx, p))
}

export function createProject(ctx: Ctx, actor: Actor, name: string): ProjectRow {
  const now = Date.now()
  const pid = id('p_')
  run(
    ctx.db,
    `insert into projects (id, device_id, account_id, org_id, name, style, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    pid,
    actor.deviceId,
    actor.account?.id ?? null,
    actor.org?.id ?? null,
    name.trim() || 'Untitled project',
    JSON.stringify(EMPTY_STYLE),
    now,
    now,
  )
  return one<ProjectRow>(ctx.db, 'select * from projects where id = ?', pid)!
}

export function cleanStyle(ctx: Ctx, input: unknown): Style {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const lists = ctx.settings.config().styleLists
  const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '')
  const pick = (v: unknown, list: string[]) => (typeof v === 'string' && list.includes(v) ? v : '')
  const length = s.length === 'one' || s.length === 'two' ? s.length : ''
  return {
    namingStyle: pick(s.namingStyle, lists.namingStyle),
    tone: pick(s.tone, lists.tone),
    length,
    include: text(s.include),
    avoid: text(s.avoid),
  }
}

export function updateProject(ctx: Ctx, actor: Actor, p: ProjectRow, body: Record<string, unknown>): ProjectRow {
  const sets: string[] = []
  const vals: unknown[] = []
  if (typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 120)
    if (!name) fail(400, 'A project needs a name.')
    sets.push('name = ?')
    vals.push(name)
  }
  if (typeof body.description === 'string') {
    sets.push('description = ?')
    vals.push(body.description.slice(0, 5000))
  }
  if (typeof body.industry === 'string') {
    sets.push('industry = ?')
    vals.push(body.industry.slice(0, 200))
  }
  if (body.style !== undefined) {
    // A pick that is no longer offered stays on a project that holds it.
    const prev = parseStyle(p.style)
    const next = cleanStyle(ctx, body.style)
    const s = body.style as Record<string, unknown>
    if (s && s.namingStyle === prev.namingStyle) next.namingStyle = prev.namingStyle
    if (s && s.tone === prev.tone) next.tone = prev.tone
    sets.push('style = ?')
    vals.push(JSON.stringify(next))
  }
  if (typeof body.shared === 'boolean') {
    if (body.shared) {
      if (!actor.account || !actor.org || !actor.org.plan_active) fail(403, 'Sharing needs a Studio organization.')
      if (p.account_id !== actor.account.id) fail(403, 'Only the member who made a project can share it.')
      sets.push('shared = 1', 'org_id = ?')
      vals.push(actor.org.id)
    } else {
      if (p.account_id !== actor.account?.id) fail(403, 'Only the member who made a project can stop sharing it.')
      sets.push('shared = 0')
    }
  }
  if (!sets.length) return p
  sets.push('updated_at = ?')
  vals.push(Date.now())
  run(ctx.db, `update projects set ${sets.join(', ')} where id = ?`, ...vals, p.id)
  const next = one<ProjectRow>(ctx.db, 'select * from projects where id = ?', p.id)!
  ctx.live.publish(p.id, { type: 'project', project: toProject(ctx, next), by: author(actor) })
  return next
}

export function deleteProjectRows(ctx: Ctx, projectId: string): void {
  tx(ctx.db, () => {
    run(ctx.db, 'delete from candidates where project_id = ?', projectId)
    run(ctx.db, 'delete from notes where project_id = ?', projectId)
    run(ctx.db, 'delete from projects where id = ?', projectId)
  })
  ctx.live.publish(projectId, { type: 'deleted' })
  ctx.live.close(projectId)
}

export function deleteProject(ctx: Ctx, actor: Actor, p: ProjectRow): void {
  const ownsIt = actor.account ? p.account_id === actor.account.id : p.device_id === actor.deviceId
  if (!ownsIt) fail(403, 'Only the member who made this project can delete it.')
  deleteProjectRows(ctx, p.id)
}

// Insert names a round produced. A name already in the project, including a
// rejected one, is never added again.
export function addCandidates(
  ctx: Ctx,
  actor: Actor,
  projectId: string,
  round: number,
  names: { name: string; reason: string; style: string }[],
): Candidate[] {
  const added: Candidate[] = []
  const now = Date.now()
  for (const n of names) {
    const key = nameKey(n.name)
    if (!key) continue
    const cid = id('c_')
    const changes = run(
      ctx.db,
      `insert into candidates (id, project_id, name, name_key, reason, style, round, added_by, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
      cid,
      projectId,
      n.name,
      key,
      n.reason,
      n.style,
      round,
      author(actor),
      now,
    )
    if (changes) {
      const c = candidate(ctx, projectId, cid)
      added.push(c)
      ctx.live.publish(projectId, { type: 'candidate', candidate: c, by: author(actor) })
    }
  }
  if (added.length) run(ctx.db, 'update projects set updated_at = ? where id = ?', now, projectId)
  return added
}

export function setStatus(ctx: Ctx, actor: Actor, projectId: string, candidateId: string, status: CandidateStatus): Candidate {
  if (!['candidate', 'kept', 'rejected'].includes(status)) fail(400, 'That is not a list status.')
  candidate(ctx, projectId, candidateId)
  run(ctx.db, 'update candidates set status = ?, changed_by = ? where id = ?', status, author(actor), candidateId)
  run(ctx.db, 'update projects set updated_at = ? where id = ?', Date.now(), projectId)
  const c = candidate(ctx, projectId, candidateId)
  ctx.live.publish(projectId, { type: 'candidate', candidate: c, by: author(actor) })
  return c
}

export function setDomain(
  ctx: Ctx,
  projectId: string,
  candidateId: string,
  domain: string | null,
  status: Candidate['domainStatus'],
  reason: string | null,
  checkedAt: number | null,
): Candidate {
  run(
    ctx.db,
    'update candidates set domain = ?, domain_status = ?, domain_reason = ?, checked_at = ? where id = ?',
    domain,
    status,
    reason,
    checkedAt,
    candidateId,
  )
  const c = candidate(ctx, projectId, candidateId)
  ctx.live.publish(projectId, { type: 'candidate', candidate: c })
  return c
}

// Notes. A note is saved only when the person submits it. Two saves of the
// same note from the same version keep both, marked as two versions.
export function saveNote(
  ctx: Ctx,
  actor: Actor,
  projectId: string,
  body: { noteId?: string; candidateId?: string | null; text: string; baseVersion?: number },
): { note: Note; conflict: boolean } {
  const now = Date.now()
  const text = body.text.slice(0, 5000)
  if (body.candidateId) candidate(ctx, projectId, body.candidateId)
  if (!body.noteId) {
    const nid = id('n_')
    run(
      ctx.db,
      'insert into notes (id, project_id, candidate_id, body, author, updated_at) values (?, ?, ?, ?, ?, ?)',
      nid,
      projectId,
      body.candidateId ?? null,
      text,
      author(actor),
      now,
    )
    const note = toNote(one<NoteRow>(ctx.db, 'select * from notes where id = ?', nid)!)
    ctx.live.publish(projectId, { type: 'note', note, by: author(actor) })
    return { note, conflict: false }
  }
  const existing = one<NoteRow>(ctx.db, 'select * from notes where id = ? and project_id = ?', body.noteId, projectId)
  if (!existing) fail(404, 'That note no longer exists.')
  const changed = run(
    ctx.db,
    'update notes set body = ?, author = ?, version = version + 1, updated_at = ? where id = ? and version = ?',
    text,
    author(actor),
    now,
    existing.id,
    body.baseVersion ?? existing.version,
  )
  if (changed) {
    const note = toNote(one<NoteRow>(ctx.db, 'select * from notes where id = ?', existing.id)!)
    ctx.live.publish(projectId, { type: 'note', note, by: author(actor) })
    return { note, conflict: false }
  }
  // Someone saved this note first: keep both versions.
  const nid = id('n_')
  run(
    ctx.db,
    'insert into notes (id, project_id, candidate_id, body, author, conflict_of, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
    nid,
    projectId,
    existing.candidate_id,
    text,
    author(actor),
    existing.id,
    now,
  )
  const note = toNote(one<NoteRow>(ctx.db, 'select * from notes where id = ?', nid)!)
  ctx.live.publish(projectId, { type: 'note', note, by: author(actor) })
  return { note, conflict: true }
}

export function deleteNote(ctx: Ctx, actor: Actor, projectId: string, noteId: string): void {
  const n = one<NoteRow>(ctx.db, 'select * from notes where id = ? and project_id = ?', noteId, projectId)
  if (!n) fail(404, 'That note no longer exists.')
  run(ctx.db, 'delete from notes where id = ?', noteId)
  // Choosing one of two versions: the kept version becomes the note.
  if (!n.conflict_of) {
    const sibling = one<NoteRow>(ctx.db, 'select * from notes where conflict_of = ? order by updated_at limit 1', noteId)
    if (sibling) run(ctx.db, 'update notes set conflict_of = null where id = ?', sibling.id)
    run(ctx.db, 'update notes set conflict_of = ? where conflict_of = ?', sibling?.id ?? null, noteId)
  }
  ctx.live.publish(projectId, { type: 'note-deleted', noteId, by: author(actor) })
  ctx.live.publish(projectId, { type: 'refresh' })
}

// Signing in attaches every project made on this device to the account.
// Nothing is dropped or rewritten; a name clash is marked for the person to
// choose which copy to keep.
export function attachDeviceProjects(ctx: Ctx, deviceId: string, accountId: string, orgId: string | null): number {
  const mine = all<ProjectRow>(ctx.db, 'select * from projects where device_id = ? and account_id is null', deviceId)
  for (const p of mine) {
    const clash = one<{ id: string }>(
      ctx.db,
      'select id from projects where account_id = ? and lower(name) = lower(?) and id != ?',
      accountId,
      p.name,
      p.id,
    )
    run(ctx.db, 'update projects set account_id = ?, org_id = ?, conflict_with = ? where id = ?', accountId, orgId, clash?.id ?? null, p.id)
  }
  return mine.length
}

export function resolveConflict(ctx: Ctx, actor: Actor, p: ProjectRow, keep: 'this' | 'other' | 'both'): void {
  if (!p.conflict_with) fail(400, 'This project has no second copy to choose from.')
  const other = one<ProjectRow>(ctx.db, 'select * from projects where id = ?', p.conflict_with)
  if (keep === 'this' && other && canSee(actor, other)) deleteProjectRows(ctx, other.id)
  if (keep === 'other') {
    deleteProjectRows(ctx, p.id)
    return
  }
  run(ctx.db, 'update projects set conflict_with = null where id = ?', p.id)
}
