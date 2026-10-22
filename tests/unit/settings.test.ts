import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openDatabase } from '../../server/db.ts'
import type { Db } from '../../server/db.ts'
import {
  SETTING_DEFINITIONS,
  SETTING_DEFAULTS,
  Settings,
  SettingsError,
  settingDefinition,
} from '../../server/settings.ts'

function memoryDb(t: { after(fn: () => void): void }): Db {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  return db
}

function refusedBy(code: string, message?: RegExp) {
  return (error: unknown): boolean => {
    if (!(error instanceof SettingsError)) return false
    if (error.code !== code) return false
    return message ? message.test(error.message) : true
  }
}

describe('operator settings', () => {
  test('the fixed set is stored with its shipped defaults', (t) => {
    const db = memoryDb(t)
    const settings = new Settings(db)

    assert.deepEqual(
      Object.fromEntries(settings.all().map((setting) => [setting.key, setting.value])),
      {
        'free.rounds': 5,
        'free.revisions': 3,
        'free.checks': 36,
        'round.batch': 12,
        'pro.rounds': 60,
        'pro.revisions': 40,
        'pro.checks': 400,
        'studio.rounds': 50,
        'studio.revisions': 30,
        'studio.checks': 300,
        'level.quick.multiplier': 1,
        'level.balanced.multiplier': 2,
        'level.thorough.multiplier': 3,
        'network.ceiling': 50,
        'domain.freshnessMinutes': 1440,
      },
    )

    // The set is fixed: every definition has one stored row.
    assert.equal(settings.all().length, SETTING_DEFINITIONS.length)
    for (const setting of SETTING_DEFINITIONS) {
      const row = db.prepare('select value from settings where key = ?').get(setting.key) as { value: string }
      assert.equal(JSON.parse(row.value), setting.defaultValue)
      assert.equal(settingDefinition(setting.key)?.label, setting.label)
    }

    // The ceiling starts at ten times the free rounds for one month.
    assert.equal(settings.get('network.ceiling'), settings.get('free.rounds') * 10)
  })

  test('a write refuses anything that is not a positive whole number', (t) => {
    const db = memoryDb(t)
    const settings = new Settings(db)

    const refused = [0, -1, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', '', null, undefined, true, {}, []]
    for (const value of refused) {
      assert.throws(
        () => settings.set('free.rounds', value, 'operator@example.com'),
        refusedBy('invalid_value', /positive whole number/),
        `expected ${String(value)} to be refused`,
      )
    }

    // A refused write leaves the old value in use and records nothing.
    assert.equal(settings.get('free.rounds'), 5)
    assert.equal(settings.changes().length, 0)
  })

  test('a batch below five is refused, both as a value and at the floor', (t) => {
    const db = memoryDb(t)
    const settings = new Settings(db)

    assert.throws(
      () => settings.set('round.batch', 4, 'operator@example.com'),
      refusedBy('invalid_value', /at least 5/),
    )
    assert.throws(
      () => settings.set('round.batch', 0, 'operator@example.com'),
      refusedBy('invalid_value', /positive whole number/),
    )
    assert.equal(settings.get('round.batch'), 12)
    assert.equal(settings.changes().length, 0)

    const accepted = settings.set('round.batch', 5, 'operator@example.com')
    assert.equal(accepted.newValue, 5)
    assert.equal(settings.get('round.batch'), 5)
  })

  test('an unknown setting or a missing operator is refused', (t) => {
    const db = memoryDb(t)
    const settings = new Settings(db)

    assert.throws(
      () => settings.set('free.names', 10, 'operator@example.com'),
      refusedBy('unknown_setting', /no setting/),
    )
    assert.throws(() => settings.get('free.names'), refusedBy('unknown_setting'))
    assert.throws(
      () => settings.set('free.rounds', 6, '   '),
      refusedBy('operator_required', /operator/),
    )
    assert.throws(
      () => settings.set('free.rounds', 6, undefined),
      refusedBy('operator_required', /operator/),
    )
    assert.equal(settings.get('free.rounds'), 5)
    assert.equal(settings.changes().length, 0)
  })

  test('a change records the setting, old value, new value, time and operator', (t) => {
    const db = memoryDb(t)
    let now = new Date('2026-10-23T05:00:00.000Z')
    const settings = new Settings(db, () => now)

    const first = settings.set('free.rounds', 7, ' operator@example.com ', 'launch allowance')
    assert.deepEqual(
      {
        setting: first.setting,
        oldValue: first.oldValue,
        newValue: first.newValue,
        changedAt: first.changedAt,
        operator: first.operator,
        reason: first.reason,
      },
      {
        setting: 'free.rounds',
        oldValue: 5,
        newValue: 7,
        changedAt: now.getTime(),
        operator: 'operator@example.com',
        reason: 'launch allowance',
      },
    )

    now = new Date('2026-10-24T06:30:00.000Z')
    const second = settings.set('free.rounds', 9, 'second@example.com')
    assert.equal(second.oldValue, 7)
    assert.equal(second.newValue, 9)
    assert.equal(second.changedAt, now.getTime())
    assert.equal(second.reason, null)

    const records = settings.changes()
    assert.deepEqual(
      records.map((change) => [change.setting, change.oldValue, change.newValue, change.operator, change.reason]),
      [
        ['free.rounds', 7, 9, 'second@example.com', null],
        ['free.rounds', 5, 7, 'operator@example.com', 'launch allowance'],
      ],
    )

    // The value is stored, and a new server-side reader sees it.
    const stored = db.prepare("select value from settings where key = 'free.rounds'").get() as { value: string }
    assert.equal(JSON.parse(stored.value), 9)
    assert.equal(new Settings(db).get('free.rounds'), 9)
  })

  test('a missing or invalid stored value falls back to the last valid one', (t) => {
    const db = memoryDb(t)
    const settings = new Settings(db)

    settings.set('free.rounds', 8, 'operator@example.com')
    assert.equal(settings.get('free.rounds'), 8)

    // A value that is not valid JSON falls back to the last valid value.
    db.prepare("update settings set value = 'not-json' where key = 'free.rounds'").run()
    assert.equal(settings.get('free.rounds'), 8)

    // A valid JSON value of the wrong shape or range does too.
    db.prepare(`update settings set value = '"eight"' where key = 'free.rounds'`).run()
    assert.equal(settings.get('free.rounds'), 8)
    db.prepare("update settings set value = '0' where key = 'free.rounds'").run()
    assert.equal(settings.get('free.rounds'), 8)

    // When the last valid column is damaged as well, the last recorded change
    // still holds the value that was in use.
    db.prepare(`update settings set value = '0', last_valid = '4.5' where key = 'free.rounds'`).run()
    assert.equal(settings.get('free.rounds'), 8)

    // A missing row falls back to the last recorded change too.
    db.prepare("delete from settings where key = 'free.rounds'").run()
    assert.equal(settings.get('free.rounds'), 8)

    // A setting that was never changed falls back to its shipped default.
    db.prepare(`update settings set value = '0', last_valid = 'not-json' where key = 'free.checks'`).run()
    assert.equal(settings.get('free.checks'), 36)
    db.prepare("delete from settings where key = 'free.checks'").run()
    assert.equal(settings.get('free.checks'), 36)

    // An invalid batch never falls below five either.
    db.prepare(`update settings set value = '4', last_valid = 'not-json' where key = 'round.batch'`).run()
    assert.equal(settings.get('round.batch'), 12)
  })

  test('resetting a setting records the change and restores its default', (t) => {
    const db = memoryDb(t)
    const settings = new Settings(db)

    settings.set('free.revisions', 7, 'operator@example.com')
    const change = settings.reset('free.revisions', 'operator@example.com', 'back to the shipped value')

    assert.equal(change.setting, 'free.revisions')
    assert.equal(change.oldValue, 7)
    assert.equal(change.newValue, 3)
    assert.equal(settings.get('free.revisions'), 3)
    assert.equal(
      (db.prepare("select count(*) as count from settings where key = 'free.revisions'").get() as { count: number })
        .count,
      0,
    )
    assert.equal(settings.changes()[0]?.newValue, 3)
  })

  test('a new value applies to the next counted action, never the last one', (t) => {
    const db = memoryDb(t)
    const settings = new Settings(db)
    let roundsSpent = 0

    const runRound = (): void => {
      // A counted action reads the cost when it starts.
      roundsSpent += settings.get('level.balanced.multiplier')
    }

    runRound()
    assert.equal(roundsSpent, 2)

    settings.set('level.balanced.multiplier', 3, 'operator@example.com')
    runRound()
    assert.equal(roundsSpent, 5, 'the earlier round keeps its old cost; the next round pays the new one')

    assert.deepEqual(
      settings
        .all()
        .filter((setting) => setting.key.startsWith('level.'))
        .map((setting) => [setting.key, setting.value]),
      [
        ['level.quick.multiplier', 1],
        ['level.balanced.multiplier', 3],
        ['level.thorough.multiplier', 3],
      ],
    )
  })

  test('the shipped default table matches every definition', () => {
    for (const setting of SETTING_DEFINITIONS) {
      assert.equal(SETTING_DEFAULTS[setting.key], setting.defaultValue)
      assert.ok(setting.minimum >= 1)
    }
  })
})
