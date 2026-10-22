// Failures and operator alerts (Failures.repeatAlert, OperatorAlerts). One
// failure is recorded. The same part failing several times in a short window,
// several people failing the same part, or one person failing the same action
// several times in a row raises an alert. An alert holds the part, the time
// and the reason, never a description, a name or a domain result.

import type { Db } from './db.ts'
import { all, one, run } from './db.ts'

export const ALERT_WINDOW_MS = 10 * 60 * 1000
const PART_THRESHOLD = 3
const PEOPLE_THRESHOLD = 2
const IN_A_ROW = 3

export interface AlertRow {
  id: number
  part: string
  began_at: number
  last_at: number
  failures: number
  people: string
  reason: string
  detail: string | null
  raises: number
  emailed: number
  dismissed_at: number | null
}

export class Alerts {
  private db: Db
  private notify: (alert: AlertRow) => void
  // Consecutive failures of one person and action, cleared by a success.
  private streaks = new Map<string, number>()

  constructor(db: Db, notify: (alert: AlertRow) => void) {
    this.db = db
    this.notify = notify
  }

  succeeded(part: string, subject: string | null): void {
    if (subject) this.streaks.delete(part + '|' + subject)
  }

  failed(part: string, action: string, subject: string | null, reason: string, detail: string, now = Date.now()): void {
    const cleanDetail = detail.slice(0, 500)
    run(
      this.db,
      'insert into failures (at, part, action, subject, reason, detail) values (?, ?, ?, ?, ?, ?)',
      now,
      part,
      action,
      subject,
      reason,
      cleanDetail,
    )
    const since = now - ALERT_WINDOW_MS
    const recent = all<{ subject: string | null }>(this.db, 'select subject from failures where part = ? and at > ?', part, since)
    const people = new Set(recent.map((r) => r.subject).filter((s): s is string => !!s))
    let streak = 0
    if (subject) {
      const k = part + '|' + subject
      streak = (this.streaks.get(k) ?? 0) + 1
      this.streaks.set(k, streak)
    }
    const raise = recent.length >= PART_THRESHOLD || people.size >= PEOPLE_THRESHOLD || streak >= IN_A_ROW
    if (!raise) return

    const open = one<AlertRow>(this.db, 'select * from alerts where part = ? and dismissed_at is null order by id desc limit 1', part)
    if (open) {
      const merged = new Set<string>([...JSON.parse(open.people), ...people])
      run(
        this.db,
        'update alerts set last_at = ?, failures = failures + 1, people = ?, reason = ?, detail = ?, raises = raises + 1 where id = ?',
        now,
        JSON.stringify([...merged]),
        reason,
        cleanDetail,
        open.id,
      )
      const updated = one<AlertRow>(this.db, 'select * from alerts where id = ?', open.id)!
      // The same part alerting twice in the short window leaves by email.
      if (!updated.emailed && updated.raises >= 2 && now - updated.began_at <= ALERT_WINDOW_MS) {
        run(this.db, 'update alerts set emailed = 1 where id = ?', open.id)
        this.notify(updated)
      }
    } else {
      run(
        this.db,
        'insert into alerts (part, began_at, last_at, failures, people, reason, detail) values (?, ?, ?, ?, ?, ?, ?)',
        part,
        now,
        now,
        recent.length,
        JSON.stringify([...people]),
        reason,
        cleanDetail,
      )
    }
  }

  list(): (Omit<AlertRow, 'people'> & { people: number })[] {
    return all<AlertRow>(this.db, 'select * from alerts order by last_at desc limit 200').map((a) => ({
      ...a,
      people: JSON.parse(a.people).length,
    }))
  }

  dismiss(id: number): void {
    run(this.db, 'update alerts set dismissed_at = ? where id = ?', Date.now(), id)
  }

  failuresFor(part: string, limit = 50) {
    return all(this.db, 'select id, at, part, action, reason, detail from failures where part = ? order by id desc limit ?', part, limit)
  }
}
