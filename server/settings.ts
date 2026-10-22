// Operator settings (Limits, Admin). The set of settings is fixed here; only
// their values change, and only from the admin interface. A missing or
// invalid stored value never blocks a person: the last valid value, or the
// shipped default, stays in use.

import type { Db } from './db.ts'
import { all, one, run } from './db.ts'
import type { Level } from '../shared/types.ts'

export interface NumberSetting {
  key: string
  label: string
  group: string
  def: number
  min: number
}

const n = (key: string, label: string, group: string, def: number, min = 1): NumberSetting => ({
  key,
  label,
  group,
  def,
  min,
})

export const NUMBER_SETTINGS: NumberSetting[] = [
  n('free.rounds', 'Free generation rounds per month', 'Free allowance', 5),
  n('free.revisions', 'Free revision rounds per month', 'Free allowance', 3),
  n('free.checks', 'Free domain checks per month', 'Free allowance', 20),
  n('pro.rounds', 'Pro generation rounds per month', 'Pro plan', 60),
  n('pro.revisions', 'Pro revision rounds per month', 'Pro plan', 40),
  n('pro.checks', 'Pro domain checks per month', 'Pro plan', 400),
  n('studio.rounds', 'Studio generation rounds per seat per month', 'Studio plan', 50),
  n('studio.revisions', 'Studio revision rounds per seat per month', 'Studio plan', 30),
  n('studio.checks', 'Studio domain checks per seat per month', 'Studio plan', 300),
  n('round.batch', 'Names in a round at Balanced', 'Rounds', 12, 5),
  n('level.quick.multiplier', 'Quick: rounds spent per round', 'Effort levels', 1),
  n('level.balanced.multiplier', 'Balanced: rounds spent per round', 'Effort levels', 2),
  n('level.thorough.multiplier', 'Thorough: rounds spent per round', 'Effort levels', 3),
  n('level.quick.credits', 'Quick: credits spent per round', 'Effort levels', 1),
  n('level.balanced.credits', 'Balanced: credits spent per round', 'Effort levels', 1),
  n('level.thorough.credits', 'Thorough: credits spent per round', 'Effort levels', 3),
  n('network.ceiling', 'Free rounds per network address per month', 'Free use ceiling', 50),
  n('domain.freshnessMinutes', 'Minutes a domain result stays fresh', 'Domain checks', 1440),
  n('price.pro', 'Pro price per month (cents)', 'Prices', 1500),
  n('price.studioSeat', 'Studio price per seat per month (cents)', 'Prices', 1200),
  n('credits.packSize', 'Credits in a pack', 'Prices', 10),
  n('credits.packPrice', 'Price of a credit pack (cents)', 'Prices', 900),
]

export interface Config {
  levels: Record<Level, { label: string; model: string }>
  styleLists: { namingStyle: string[]; tone: string[] }
  paidLookup: null | { name: string; url: string }
  currency: string
}

export const DEFAULT_CONFIG: Config = {
  levels: {
    quick: { label: 'Quick', model: 'claude-haiku-5-5' },
    balanced: { label: 'Balanced', model: 'claude-sonnet-5-5' },
    thorough: { label: 'Thorough', model: 'claude-opus-5-5' },
  },
  styleLists: {
    namingStyle: ['descriptive', 'invented', 'compound', 'evocative', 'metaphor', 'acronym'],
    tone: ['playful', 'serious', 'modern', 'classic', 'warm', 'bold'],
  },
  paidLookup: null,
  currency: 'usd',
}

export function validNumber(s: NumberSetting, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return `${s.label} must be a positive whole number.`
  }
  if (value < s.min) return `${s.label} must be at least ${s.min}.`
  return null
}

export function validConfig(value: unknown): string | null {
  const c = value as Config
  if (!c || typeof c !== 'object') return 'The configuration is not readable.'
  for (const l of ['quick', 'balanced', 'thorough'] as const) {
    const lv = c.levels?.[l]
    if (!lv || typeof lv.label !== 'string' || !lv.label.trim()) return `The ${l} level needs a name.`
    if (typeof lv.model !== 'string' || !lv.model.trim()) return `The ${l} level needs a model.`
  }
  if (Object.keys(c.levels).length !== 3) return 'There are exactly three effort levels.'
  for (const list of ['namingStyle', 'tone'] as const) {
    const items = c.styleLists?.[list]
    if (!Array.isArray(items) || items.some((x) => typeof x !== 'string' || !x.trim())) {
      return 'Each pick list holds short words.'
    }
  }
  if (c.paidLookup !== null) {
    if (typeof c.paidLookup?.url !== 'string' || !/^https:\/\//.test(c.paidLookup.url)) {
      return 'A paid lookup service needs an https address.'
    }
  }
  if (typeof c.currency !== 'string' || !/^[a-z]{3}$/.test(c.currency)) return 'The currency is a three-letter code.'
  return null
}

export class Settings {
  private db: Db
  private nums = new Map<string, number>()
  private cfg: Config = DEFAULT_CONFIG

  constructor(db: Db) {
    this.db = db
    this.reload()
  }

  reload(): void {
    const rows = all<{ key: string; value: string; last_valid: string | null }>(this.db, 'select * from settings')
    const stored = new Map(rows.map((r) => [r.key, r]))
    for (const s of NUMBER_SETTINGS) {
      this.nums.set(s.key, this.pick(stored.get(s.key), s.def, (v) => validNumber(s, v)))
    }
    this.cfg = this.pick(stored.get('config'), DEFAULT_CONFIG, validConfig)
  }

  private pick<T>(row: { value: string; last_valid: string | null } | undefined, def: T, check: (v: unknown) => string | null): T {
    if (!row) return def
    for (const raw of [row.value, row.last_valid]) {
      if (raw == null) continue
      try {
        const v = JSON.parse(raw)
        if (check(v) === null) return v
      } catch {
        // fall through to the last valid value
      }
    }
    return def
  }

  num(key: string): number {
    const v = this.nums.get(key)
    if (v === undefined) throw new Error('unknown setting ' + key)
    return v
  }

  config(): Config {
    return this.cfg
  }

  all(): { key: string; label: string; group: string; value: number; def: number; min: number }[] {
    return NUMBER_SETTINGS.map((s) => ({ ...s, value: this.num(s.key) }))
  }

  setNumber(key: string, value: unknown, operator: string, reason: string): string | null {
    const s = NUMBER_SETTINGS.find((x) => x.key === key)
    if (!s) return 'There is no such setting.'
    const problem = validNumber(s, value)
    if (problem) return problem
    const old = this.num(key)
    this.write(key, JSON.stringify(value))
    audit(this.db, operator, 'setting', key, String(old), String(value), reason)
    this.reload()
    return null
  }

  resetNumber(key: string, operator: string, reason: string): string | null {
    const s = NUMBER_SETTINGS.find((x) => x.key === key)
    if (!s) return 'There is no such setting.'
    const old = this.num(key)
    run(this.db, 'delete from settings where key = ?', key)
    audit(this.db, operator, 'setting cleared', key, String(old), String(s.def), reason)
    this.reload()
    return null
  }

  setConfig(value: unknown, operator: string, reason: string): string | null {
    const problem = validConfig(value)
    if (problem) return problem
    const old = JSON.stringify(this.cfg)
    const next = JSON.stringify(value)
    this.write('config', next)
    audit(this.db, operator, 'configuration', 'config', old, next, reason)
    this.reload()
    return null
  }

  private write(key: string, value: string): void {
    run(
      this.db,
      `insert into settings (key, value, last_valid) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, last_valid = excluded.value`,
      key,
      value,
      value,
    )
  }
}

export function audit(
  db: Db,
  operator: string | null,
  action: string,
  target: string | null,
  oldValue: string | null,
  newValue: string | null,
  reason: string | null,
): void {
  run(
    db,
    'insert into audit (at, operator, action, target, old_value, new_value, reason) values (?, ?, ?, ?, ?, ?, ?)',
    Date.now(),
    operator,
    action,
    target,
    oldValue,
    newValue,
    reason,
  )
}

export function auditLog(db: Db, limit = 200) {
  return all(db, 'select * from audit order by id desc limit ?', limit)
}

export function settingRaw(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, 'select value from settings where key = ?', key)?.value
}
