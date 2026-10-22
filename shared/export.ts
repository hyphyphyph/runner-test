// Export formats (Export.formats): a spreadsheet-ready CSV of the candidate
// list, and a plain text list of names, one per line.

import type { Candidate } from './types.ts'

function csvCell(value: string): string {
  // Quote every cell, and defuse formula injection in spreadsheet programs.
  let v = value
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v
  return '"' + v.replace(/"/g, '""') + '"'
}

export interface ExportRow {
  project: string
  candidate: Candidate
  shared: boolean
}

export function toCsv(rows: ExportRow[], includeProject: boolean): string {
  const withAuthor = rows.some((r) => r.shared)
  const head = [
    ...(includeProject ? ['project'] : []),
    'name',
    'reason',
    'style',
    'domain',
    'domain status',
    'checked at',
    'list status',
    ...(withAuthor ? ['added by'] : []),
  ]
  const lines = [head.map(csvCell).join(',')]
  for (const { project, candidate: c, shared } of rows) {
    lines.push(
      [
        ...(includeProject ? [project] : []),
        c.name,
        c.reason,
        c.style,
        c.domain ?? '',
        c.domainStatus,
        c.checkedAt ? new Date(c.checkedAt).toISOString() : '',
        c.status,
        ...(withAuthor ? [shared ? (c.addedBy ?? '') : ''] : []),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\r\n') + '\r\n'
}

export function toText(candidates: Candidate[]): string {
  return candidates.map((c) => c.name).join('\n') + (candidates.length ? '\n' : '')
}

// The shortlist is the kept names, or every name still in play when nothing
// is kept yet.
export function shortlist(candidates: Candidate[]): Candidate[] {
  const kept = candidates.filter((c) => c.status === 'kept')
  if (kept.length) return kept
  return candidates.filter((c) => c.status === 'candidate')
}
