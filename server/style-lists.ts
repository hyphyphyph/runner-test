// The operator's pick lists for the style form (Admin.style).
//
// The store owns three lists: the naming style choices, the tone choices and
// the ending pick list. The first two are free labels the operator may add,
// rename or remove. An ending may enter the pick list only when it passes
// DomainCheck.offeredEndings. The offered set is injected, so the refreshed
// root zone and registry rules can replace the shipped set without changing
// this store.
//
// Removing a choice changes only what is offered from then on. It never
// touches a project, because a project keeps its own style document.

import type { Db } from './db.ts'
import type { StyleLists, StyleOption } from '../shared/style.ts'
import {
  filterEndingPicks,
  normalizeEnding,
  normalizeOptionId,
  SHIPPED_OFFERED_ENDINGS,
  SHIPPED_STYLE_LISTS,
} from '../shared/style.ts'

export type StyleListName = 'namingStyle' | 'tone'
export type StyleListAction = 'add' | 'rename' | 'remove'

export type StyleListErrorCode =
  | 'unknown_list'
  | 'invalid_option'
  | 'duplicate_option'
  | 'option_not_found'
  | 'invalid_ending'
  | 'ending_not_offered'
  | 'duplicate_ending'
  | 'operator_required'

/** A refused style list change, with a message the admin interface can show. */
export class StyleListError extends Error {
  readonly code: StyleListErrorCode
  readonly list: string

  constructor(code: StyleListErrorCode, message: string, list: string) {
    super(message)
    this.name = 'StyleListError'
    this.code = code
    this.list = list
  }
}

export interface StyleListStoreOptions {
  /** Fixed clock, so a test can check the recorded time. */
  now?: () => Date
  /**
   * Endings that pass DomainCheck.offeredEndings. The shipped set is used
   * until the root zone refresh is connected.
   */
  offeredEndings?: readonly string[]
}

/** One recorded change to the pick lists. */
export interface StyleListChange {
  id: number
  list: string
  action: StyleListAction
  optionId: string
  oldValue: string | null
  newValue: string | null
  changedAt: number
  operator: string
  reason: string | null
}

interface StoredChange {
  id: number
  list: string
  action: StyleListAction
  option_id: string
  old_value: string | null
  new_value: string | null
  changed_at: number
  operator: string
  reason: string | null
}

interface OptionRow {
  id: string
  label: string
}

/**
 * The style pick list store.
 *
 * Each read goes to the database, so an operator change applies to the next
 * form shown. The shipped lists are inserted on first use and recorded with a
 * marker, so a list the operator empties stays empty.
 */
export class StyleListStore {
  readonly #db: Db
  readonly #now: () => Date
  readonly #offered: string[]

  constructor(db: Db, options: StyleListStoreOptions = {}) {
    this.#db = db
    this.#now = options.now ?? (() => new Date())
    this.#offered = filterEndingPicks(options.offeredEndings ?? SHIPPED_OFFERED_ENDINGS, options.offeredEndings ?? SHIPPED_OFFERED_ENDINGS)
  }

  /** The lists the form shows now. Endings are filtered to the offered set. */
  lists(): StyleLists {
    this.#ensureSeeded()

    const namingStyles = this.#options('namingStyle')
    const tones = this.#options('tone')
    const endingRows = this.#db
      .prepare('select ending from style_endings order by position, ending')
      .all() as Array<{ ending: string }>
    const endings = filterEndingPicks(
      endingRows.map((row) => row.ending),
      this.#offered,
    )

    return {
      namingStyles,
      tones,
      endings,
      offeredEndings: [...this.#offered],
    }
  }

  /** Add one choice to the naming style or tone list. */
  addOption(
    list: string,
    id: string,
    label: string,
    operator: unknown,
    reason: string | null = null,
  ): StyleOption {
    const name = this.#listName(list)
    const cleanId = this.#optionId(id, name)
    const cleanLabel = this.#optionLabel(label, name)
    const person = this.#operator(operator, name)
    const note = normalizeReason(reason)
    this.#ensureSeeded()

    if (this.#option(name, cleanId) !== null) {
      throw new StyleListError('duplicate_option', 'That choice is already in the list.', name)
    }

    const now = this.#now().getTime()
    const position = this.#nextPosition('style_list_options', name)
    this.#transaction(() => {
      this.#db
        .prepare('insert into style_list_options (list, id, label, position) values (?, ?, ?, ?)')
        .run(name, cleanId, cleanLabel, position)
      this.#record(name, 'add', cleanId, null, cleanLabel, person, note, now)
    })

    return { id: cleanId, label: cleanLabel }
  }

  /** Change the words shown for one choice. The saved id stays the same. */
  renameOption(
    list: string,
    id: string,
    label: string,
    operator: unknown,
    reason: string | null = null,
  ): StyleOption {
    const name = this.#listName(list)
    const cleanId = this.#optionId(id, name)
    const cleanLabel = this.#optionLabel(label, name)
    const person = this.#operator(operator, name)
    const note = normalizeReason(reason)
    this.#ensureSeeded()

    const current = this.#option(name, cleanId)
    if (current === null) {
      throw new StyleListError('option_not_found', 'That choice is not in the list.', name)
    }

    const now = this.#now().getTime()
    this.#transaction(() => {
      this.#db
        .prepare('update style_list_options set label = ? where list = ? and id = ?')
        .run(cleanLabel, name, cleanId)
      this.#record(name, 'rename', cleanId, current.label, cleanLabel, person, note, now)
    })

    return { id: cleanId, label: cleanLabel }
  }

  /**
   * Remove one choice. Returns false when it was not there. A project that
   * already chose it keeps its style; only new picks lose the choice.
   */
  removeOption(list: string, id: string, operator: unknown, reason: string | null = null): boolean {
    const name = this.#listName(list)
    const cleanId = this.#optionId(id, name)
    const person = this.#operator(operator, name)
    const note = normalizeReason(reason)
    this.#ensureSeeded()

    const current = this.#option(name, cleanId)
    if (current === null) return false

    const now = this.#now().getTime()
    this.#transaction(() => {
      this.#db.prepare('delete from style_list_options where list = ? and id = ?').run(name, cleanId)
      this.#record(name, 'remove', cleanId, current.label, null, person, note, now)
    })
    return true
  }

  /** Add an ending to the pick list. It must pass offeredEndings. */
  addEnding(ending: string, operator: unknown, reason: string | null = null): string {
    const clean = this.#ending(ending)
    const person = this.#operator(operator, 'ending')
    const note = normalizeReason(reason)
    this.#ensureSeeded()

    if (!this.#offered.includes(clean)) {
      throw new StyleListError(
        'ending_not_offered',
        `.${clean} cannot be suggested or checked, so it cannot be a preferred ending.`,
        'ending',
      )
    }
    if (this.#endingExists(clean)) {
      throw new StyleListError('duplicate_ending', 'That ending is already in the list.', 'ending')
    }

    const now = this.#now().getTime()
    const position = this.#nextPosition('style_endings')
    this.#transaction(() => {
      this.#db.prepare('insert into style_endings (ending, position) values (?, ?)').run(clean, position)
      this.#record('ending', 'add', clean, null, clean, person, note, now)
    })
    return clean
  }

  /** Remove an ending from the pick list. It remains offered for checks. */
  removeEnding(ending: string, operator: unknown, reason: string | null = null): boolean {
    const clean = this.#ending(ending)
    const person = this.#operator(operator, 'ending')
    const note = normalizeReason(reason)
    this.#ensureSeeded()

    if (!this.#endingExists(clean)) return false

    const now = this.#now().getTime()
    this.#transaction(() => {
      this.#db.prepare('delete from style_endings where ending = ?').run(clean)
      this.#record('ending', 'remove', clean, clean, null, person, note, now)
    })
    return true
  }

  /** Recent changes, newest first. */
  changes(limit = 100): StyleListChange[] {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('The change limit must be a positive whole number.')
    }
    const rows = this.#db
      .prepare(
        `select id, list, action, option_id, old_value, new_value, changed_at, operator, reason
         from style_list_changes
         order by id desc
         limit ?`,
      )
      .all(limit) as unknown as StoredChange[]

    return rows.map((row) => ({
      id: row.id,
      list: row.list,
      action: row.action,
      optionId: row.option_id,
      oldValue: row.old_value,
      newValue: row.new_value,
      changedAt: row.changed_at,
      operator: row.operator,
      reason: row.reason,
    }))
  }

  // ---- internals --------------------------------------------------------

  #ensureSeeded(): void {
    const marker = this.#db.prepare("select value from style_list_meta where key = 'seeded'").get()
    if (marker !== undefined) return

    const now = this.#now().getTime()
    this.#transaction(() => {
      const addOption = this.#db.prepare(
        'insert or ignore into style_list_options (list, id, label, position) values (?, ?, ?, ?)',
      )
      SHIPPED_STYLE_LISTS.namingStyles.forEach((option, index) => {
        addOption.run('namingStyle', option.id, option.label, index)
      })
      SHIPPED_STYLE_LISTS.tones.forEach((option, index) => {
        addOption.run('tone', option.id, option.label, index)
      })

      const addEnding = this.#db.prepare('insert or ignore into style_endings (ending, position) values (?, ?)')
      filterEndingPicks(SHIPPED_STYLE_LISTS.endings, this.#offered).forEach((ending, index) => {
        addEnding.run(ending, index)
      })

      this.#db
        .prepare("insert or ignore into style_list_meta (key, value) values ('seeded', ?)")
        .run(String(now))
    })
  }

  #options(list: StyleListName): StyleOption[] {
    const rows = this.#db
      .prepare('select id, label from style_list_options where list = ? order by position, id')
      .all(list) as unknown as OptionRow[]
    return rows.map((row) => ({ id: row.id, label: row.label }))
  }

  #option(list: StyleListName, id: string): StyleOption | null {
    const row = this.#db
      .prepare('select id, label from style_list_options where list = ? and id = ?')
      .get(list, id) as OptionRow | undefined
    return row === undefined ? null : { id: row.id, label: row.label }
  }

  #endingExists(ending: string): boolean {
    return this.#db.prepare('select 1 as found from style_endings where ending = ?').get(ending) !== undefined
  }

  #nextPosition(table: 'style_list_options' | 'style_endings', list?: StyleListName): number {
    if (table === 'style_endings') {
      const row = this.#db
        .prepare('select coalesce(max(position), -1) + 1 as next from style_endings')
        .get() as { next: number }
      return row.next
    }
    if (list === undefined) {
      throw new Error('A naming style or tone position needs its list.')
    }
    const row = this.#db
      .prepare('select coalesce(max(position), -1) + 1 as next from style_list_options where list = ?')
      .get(list) as { next: number }
    return row.next
  }

  #record(
    list: string,
    action: StyleListAction,
    optionId: string,
    oldValue: string | null,
    newValue: string | null,
    operator: string,
    reason: string | null,
    changedAt: number,
  ): void {
    this.#db
      .prepare(
        `insert into style_list_changes
          (list, action, option_id, old_value, new_value, changed_at, operator, reason)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(list, action, optionId, oldValue, newValue, changedAt, operator, reason)
  }

  #transaction(run: () => void): void {
    this.#db.exec('savepoint style_list_write')
    try {
      run()
      this.#db.exec('release style_list_write')
    } catch (error) {
      try {
        this.#db.exec('rollback to style_list_write')
        this.#db.exec('release style_list_write')
      } catch {
        // The original error is the useful one.
      }
      throw error
    }
  }

  #listName(list: string): StyleListName {
    if (list === 'namingStyle' || list === 'tone') return list
    throw new StyleListError('unknown_list', 'That is not a style pick list.', list)
  }

  #optionId(id: string, list: string): string {
    const clean = normalizeOptionId(id)
    if (clean === null) {
      throw new StyleListError(
        'invalid_option',
        'A choice needs a short id made of lower-case letters, digits and hyphens.',
        list,
      )
    }
    return clean
  }

  #optionLabel(label: string, list: string): string {
    const clean = label.trim()
    if (clean.length === 0) {
      throw new StyleListError('invalid_option', 'A choice needs words a person can read.', list)
    }
    return clean
  }

  #ending(ending: string): string {
    const clean = normalizeEnding(ending)
    if (clean === null) {
      throw new StyleListError('invalid_ending', 'An ending must be a bare lower-case label, such as com.', 'ending')
    }
    return clean
  }

  #operator(operator: unknown, list: string): string {
    if (typeof operator !== 'string' || operator.trim().length === 0) {
      throw new StyleListError('operator_required', 'A change needs the operator who made it.', list)
    }
    return operator.trim()
  }
}

function normalizeReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const text = reason.trim()
  return text.length === 0 ? null : text
}
