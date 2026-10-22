// The account's own controls: email choices, export and deletion
// (Export, Deletion). A deleted account is kept 30 days, restorable by
// signing in, and then dropped with all its work.

import type { Ctx } from './context.ts'
import { all, one, run, tx } from './db.ts'
import type { AccountRow, Actor } from './allowance.ts'
import { requireAccount } from './auth.ts'
import { OPTIONAL_EMAILS } from './email.ts'
import { fail } from './http.ts'
import type { ProjectRow } from './projects.ts'
import { candidates, deleteProjectRows, getProject, listProjects } from './projects.ts'
import { shortlist, toCsv, toText } from '../shared/export.ts'
import type { ExportRow } from '../shared/export.ts'

export const GRACE_MS = 30 * 24 * 60 * 60 * 1000

export function setEmailPrefs(ctx: Ctx, actor: Actor, prefs: Record<string, unknown>): Record<string, boolean> {
  const a = requireAccount(actor)
  const current = JSON.parse(a.email_prefs) as Record<string, boolean>
  for (const key of Object.keys(OPTIONAL_EMAILS)) if (typeof prefs[key] === 'boolean') current[key] = prefs[key] as boolean
  run(ctx.db, 'update accounts set email_prefs = ? where id = ?', JSON.stringify(current), a.id)
  return current
}

export function exportFile(ctx: Ctx, actor: Actor, projectId: string | null, format: string, list: string) {
  const projects: ProjectRow[] = projectId
    ? [getProject(ctx, actor, projectId)]
    : listProjects(ctx, actor).map((p) => getProject(ctx, actor, p.id))
  const rows: ExportRow[] = []
  for (const p of projects) {
    let cs = candidates(ctx, p.id).filter((c) => c.status !== 'dropped')
    if (list === 'shortlist') cs = shortlist(cs)
    for (const c of cs) rows.push({ project: p.name, candidate: c, shared: p.shared === 1 })
  }
  const base = projectId ? projects[0].name : 'nametempest-projects'
  if (format === 'txt') {
    return { type: 'text/plain; charset=utf-8', name: `${base}.txt`, body: toText(rows.map((r) => r.candidate)) }
  }
  return { type: 'text/csv; charset=utf-8', name: `${base}.csv`, body: '﻿' + toCsv(rows, !projectId) }
}

// What deleting would remove, shown before the person confirms.
export function deletionPreview(ctx: Ctx, actor: Actor) {
  const a = requireAccount(actor)
  const owned = one<{ name: string }>(ctx.db, 'select name from orgs where owner_id = ?', a.id)
  const projects = (ctx.db.prepare('select count(*) as n from projects where account_id = ?').get(a.id) as { n: number }).n
  return {
    projects,
    credits: a.credits,
    ownsOrg: owned?.name ?? null,
    removeOn: Date.now() + GRACE_MS,
  }
}

export function requestDeletion(ctx: Ctx, actor: Actor): { removeOn: number } {
  const a = requireAccount(actor)
  const owned = one<{ name: string }>(ctx.db, 'select name from orgs where owner_id = ?', a.id)
  if (owned) {
    fail(
      409,
      `You own the studio "${owned.name}". Close it, or hand it to another member, before deleting your account.`,
    )
  }
  const now = Date.now()
  const removeOn = now + GRACE_MS
  tx(ctx.db, () => {
    run(ctx.db, 'update accounts set deleted_at = ?, purge_at = ? where id = ?', now, removeOn, a.id)
    run(ctx.db, 'delete from sessions where account_id = ?', a.id)
  })
  ctx.mail.queue(a.email, 'deletion-soon', 'Your account will be deleted', [
    `Your account and its projects, counters and sign-in will be removed for good on ${new Date(removeOn).toUTCString()}.`,
    'Until then you can restore everything by signing in again.',
  ])
  return { removeOn }
}

// Drop accounts whose grace period ended, with every trace of their work.
export function purge(ctx: Ctx, now = Date.now()): number {
  const due = all<AccountRow>(ctx.db, 'select * from accounts where purge_at is not null and purge_at <= ?', now)
  for (const a of due) {
    const projects = all<{ id: string }>(ctx.db, 'select id from projects where account_id = ?', a.id)
    for (const p of projects) deleteProjectRows(ctx, p.id)
    tx(ctx.db, () => {
      run(ctx.db, 'delete from org_members where account_id = ?', a.id)
      run(ctx.db, 'delete from usage where subject = ?', 'account:' + a.id)
      run(ctx.db, 'delete from sessions where account_id = ?', a.id)
      run(ctx.db, 'delete from magic_links where email = ?', a.email)
      run(ctx.db, 'delete from accounts where id = ?', a.id)
    })
    ctx.mail.queue(a.email, 'deleted', 'Your account was deleted', [
      'Your NameTempest account and all its work have now been removed. Nothing is kept.',
    ])
  }
  // Network address hashes are kept only for the current month.
  run(ctx.db, 'delete from network_usage where month < ?', new Date(now).toISOString().slice(0, 7))
  run(ctx.db, 'delete from magic_links where expires_at < ?', now - 24 * 60 * 60 * 1000)
  run(ctx.db, 'delete from failures where at < ?', now - 30 * 24 * 60 * 60 * 1000)
  return due.length
}
