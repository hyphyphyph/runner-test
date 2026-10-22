// Operator limit settings (Limits, Admin).
//
// The set of settings is fixed here; only their values change, and only the
// server reads or writes them. A write refuses anything that is not a
// positive whole number, and the batch size has a floor of five names. Every
// change appends a record with the old value, the new value, the time and the
// operator.
//
// A value is looked up on every read, so a change applies to the next counted
// action rather than to work already spent. If the stored value is missing or
// invalid, the last valid value stays in use; if that is gone too, the
// shipped default does. A bad setting never blocks a person.

import type { Db } from './db.ts'

/** One setting in the fixed set. */
export interface SettingDefinition {
  /** Stable key used in the database and the admin interface. */
  key: string
  /** Plain words shown to the operator. */
  label: string
  /** The part of the admin interface this setting belongs to. */
  group: string
  /** The value shipped before the operator changes anything. */
  defaultValue: number
  /** The smallest value this setting may hold. */
  minimum: number
}

const definition = (
  key: string,
  label: string,
  group: string,
  defaultValue: number,
  minimum = 1,
): SettingDefinition => ({ key, label, group, defaultValue, minimum })

/**
 * The fixed set of settings.
 *
 * The defaults are the shipped values from Limits and Generation.batch. The
 * plan allowances and the freshness window are starting values chosen for
 * this build; the specification leaves their exact numbers to the operator.
 */
export const SETTING_DEFINITIONS = [
  definition('free.rounds', 'Free generation rounds per month', 'Free allowance', 5),
  definition('free.revisions', 'Free revision rounds per month', 'Free allowance', 3),
  definition('free.checks', 'Free domain checks per month', 'Free allowance', 36),
  definition('round.batch', 'Names in a round at Balanced', 'Rounds', 12, 5),
  definition('pro.rounds', 'Pro generation rounds per month', 'Pro plan', 60),
  definition('pro.revisions', 'Pro revision rounds per month', 'Pro plan', 40),
  definition('pro.checks', 'Pro domain checks per month', 'Pro plan', 400),
  definition('studio.rounds', 'Studio generation rounds per seat per month', 'Studio plan', 50),
  definition('studio.revisions', 'Studio revision rounds per seat per month', 'Studio plan', 30),
  definition('studio.checks', 'Studio domain checks per seat per month', 'Studio plan', 300),
  definition('level.quick.multiplier', 'Quick: rounds spent per round', 'Effort levels', 1),
  definition('level.balanced.multiplier', 'Balanced: rounds spent per round', 'Effort levels', 2),
  definition('level.thorough.multiplier', 'Thorough: rounds spent per round', 'Effort levels', 3),
  definition('network.ceiling', 'Free rounds per network address per month', 'Free use ceiling', 50),
  definition('domain.freshnessMinutes', 'Minutes a domain result stays fresh', 'Domain checks', 1440),
] as const satisfies readonly SettingDefinition[]

/** Every key in the fixed set. */
export type SettingKey = (typeof SETTING_DEFINITIONS)[number]['key']

/** The shipped value of each setting. */
export const SETTING_DEFAULTS: Readonly<Record<SettingKey, number>> = Object.freeze(
  Object.fromEntries(SETTING_DEFINITIONS.map((setting) => [setting.key, setting.defaultValue])) as Record<
    SettingKey,
    number
  >,
)

const byKey = new Map<string, SettingDefinition>(SETTING_DEFINITIONS.map((setting) => [setting.key, setting]))

/** The definition of one setting, or undefined for an unknown key. */
export function settingDefinition(key: string): SettingDefinition | undefined {
  return byKey.get(key)
}

/** Why a write was refused. */
export type SettingsErrorCode = 'unknown_setting' | 'invalid_value' | 'operator_required'

/** A refused write, with a message that can be shown to the operator. */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode
  readonly setting: string | null

  constructor(code: SettingsErrorCode, message: string, setting: string | null = null) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
    this.setting = setting
  }
}

/**
 * Check a proposed value. Returns a plain message when it is refused, or null
 * when it is accepted. Only a whole number of at least one is a value; the
 * batch size is also refused below its minimum of five.
 */
export function validateSettingValue(setting: SettingDefinition, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return `${setting.label} must be a positive whole number.`
  }
  if (value < setting.minimum) {
    return `${setting.label} must be at least ${setting.minimum}.`
  }
  return null
}

/** A setting and the value in use now. */
export interface SettingValue extends SettingDefinition {
  value: number
}

/** One recorded change to a setting. */
export interface SettingChange {
  id: number
  setting: string
  oldValue: number
  newValue: number
  changedAt: number
  operator: string
  reason: string | null
}

interface StoredSetting {
  value: string
  last_valid: string | null
}

interface StoredChange {
  id: number
  setting: string
  old_value: number
  new_value: number
  changed_at: number
  operator: string
  reason: string | null
}

/**
 * The settings store.
 *
 * Reads go to the database each time, so the next counted action always sees
 * the value the operator last saved. The store is constructed with the open
 * database; the clock is injectable so a test can fix the recorded time.
 */
export class Settings {
  readonly #db: Db
  readonly #now: () => Date

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.#db = db
    this.#now = now
  }

  /** The value in use for one setting. */
  get(key: string): number {
    const setting = this.#definition(key)
    return this.#resolve(setting)
  }

  /** The whole fixed set, with the value in use for each setting. */
  all(): SettingValue[] {
    return SETTING_DEFINITIONS.map((setting) => ({ ...setting, value: this.#resolve(setting) }))
  }

  /**
   * Save a new value and append the change record.
   *
   * Throws SettingsError when the key is not in the fixed set, the value is
   * not a positive whole number (or a batch below five), or no operator is
   * named. A refused write changes nothing.
   */
  set(key: string, value: unknown, operator: unknown, reason: string | null = null): SettingChange {
    const setting = this.#definition(key)
    const problem = validateSettingValue(setting, value)
    if (problem) throw new SettingsError('invalid_value', problem, key)

    const person = this.#operator(operator, key)
    const oldValue = this.#resolve(setting)
    const newValue = value as number
    const changedAt = this.#now().getTime()
    const note = normalizeReason(reason)

    let id: number
    this.#db.exec('savepoint name_tempest_setting_change')
    try {
      this.#db
        .prepare(
          `insert into settings (key, value, last_valid) values (?, ?, ?)
           on conflict(key) do update set value = excluded.value, last_valid = excluded.value`,
        )
        .run(key, JSON.stringify(newValue), JSON.stringify(newValue))

      const result = this.#db
        .prepare(
          `insert into setting_changes (setting, old_value, new_value, changed_at, operator, reason)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(key, oldValue, newValue, changedAt, person, note)

      id = Number(result.lastInsertRowid)
      this.#db.exec('release name_tempest_setting_change')
    } catch (error) {
      this.#db.exec('rollback to name_tempest_setting_change')
      this.#db.exec('release name_tempest_setting_change')
      throw error
    }

    return { id, setting: key, oldValue, newValue, changedAt, operator: person, reason: note }
  }

  /**
   * Clear one stored value so its shipped default applies again. The change
   * is recorded like any other, with the default as the new value.
   */
  reset(key: string, operator: unknown, reason: string | null = null): SettingChange {
    const setting = this.#definition(key)
    const person = this.#operator(operator, key)
    const oldValue = this.#resolve(setting)
    const newValue = setting.defaultValue
    const changedAt = this.#now().getTime()
    const note = normalizeReason(reason)

    let id: number
    this.#db.exec('savepoint name_tempest_setting_reset')
    try {
      this.#db.prepare('delete from settings where key = ?').run(key)

      const result = this.#db
        .prepare(
          `insert into setting_changes (setting, old_value, new_value, changed_at, operator, reason)
           values (?, ?, ?, ?, ?, ?)`,
        )
        .run(key, oldValue, newValue, changedAt, person, note)

      id = Number(result.lastInsertRowid)
      this.#db.exec('release name_tempest_setting_reset')
    } catch (error) {
      this.#db.exec('rollback to name_tempest_setting_reset')
      this.#db.exec('release name_tempest_setting_reset')
      throw error
    }

    return { id, setting: key, oldValue, newValue, changedAt, operator: person, reason: note }
  }

  /** Recent changes, newest first. */
  changes(limit = 100): SettingChange[] {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('The change limit must be a positive whole number.')

    const rows = this.#db
      .prepare(
        `select id, setting, old_value, new_value, changed_at, operator, reason
         from setting_changes
         order by id desc
         limit ?`,
      )
      .all(limit) as unknown as StoredChange[]

    return rows.map((row) => ({
      id: row.id,
      setting: row.setting,
      oldValue: row.old_value,
      newValue: row.new_value,
      changedAt: row.changed_at,
      operator: row.operator,
      reason: row.reason,
    }))
  }

  #definition(key: string): SettingDefinition {
    const setting = byKey.get(key)
    if (!setting) throw new SettingsError('unknown_setting', `There is no setting named ${key}.`, key)
    return setting
  }

  #operator(operator: unknown, key: string): string {
    if (typeof operator !== 'string' || operator.trim().length === 0) {
      throw new SettingsError('operator_required', 'A setting change needs the operator who made it.', key)
    }
    return operator.trim()
  }

  #resolve(setting: SettingDefinition): number {
    const row = this.#db.prepare('select value, last_valid from settings where key = ?').get(setting.key) as
      | StoredSetting
      | undefined

    if (row) {
      for (const raw of [row.value, row.last_valid]) {
        if (raw === null) continue
        try {
          const value: unknown = JSON.parse(raw)
          if (validateSettingValue(setting, value) === null) return value as number
        } catch {
          // A damaged stored value falls through to the last valid one.
        }
      }
    }

    return this.#lastRecordedValue(setting)
  }

  /**
   * The last value this setting actually saved. It covers a row that is
   * missing or whose current and last-valid values are both damaged, so the
   * last good value keeps applying. Before the first change, the shipped
   * default is the last valid value.
   */
  #lastRecordedValue(setting: SettingDefinition): number {
    const row = this.#db
      .prepare('select new_value from setting_changes where setting = ? order by id desc limit 1')
      .get(setting.key) as { new_value: number } | undefined
    if (row && validateSettingValue(setting, row.new_value) === null) return row.new_value
    return setting.defaultValue
  }
}

function normalizeReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const text = reason.trim()
  return text.length === 0 ? null : text
}
