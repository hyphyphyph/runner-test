import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { countMigrations, loadMigrations, migrate, openDatabase } from '../../server/db.ts'

describe('migrations', () => {
  test('the migration files are ordered and readable', () => {
    const migrations = loadMigrations()
    assert.ok(migrations.length >= 1)
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [...migrations.map((migration) => migration.version)].sort((a, b) => a.localeCompare(b, 'en')),
    )
    for (const migration of migrations) {
      assert.match(migration.version, /^\d+$/)
      assert.ok(migration.sql.length > 0)
    }
  })

  test('opening a database applies every migration', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const migrations = loadMigrations()
    assert.equal(countMigrations(db), migrations.length)
    const applied = db.prepare('select version, name from schema_migrations order by version').all() as Array<{
      version: string
      name: string
    }>
    assert.deepEqual(
      applied.map((row) => row.version),
      migrations.map((migration) => migration.version),
    )
    assert.deepEqual(
      applied.map((row) => row.name),
      migrations.map((migration) => migration.name),
    )
  })

  test('migrating twice changes nothing', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const before = countMigrations(db)
    assert.equal(migrate(db), before)
    assert.equal(migrate(db), before)
  })

  test('a file database keeps its applied migrations across opens', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'nametempest-db-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))

    const file = join(directory, 'nametempest.db')
    const first = openDatabase(file)
    const count = countMigrations(first)
    first.close()

    const second = openDatabase(file)
    t.after(() => second.close())
    assert.equal(countMigrations(second), count)
  })
})

describe('database rules', () => {
  test('a project must point at an owner or a device', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    assert.throws(
      () =>
        db
          .prepare("insert into projects (id, name, created_at, updated_at) values ('p1', 'Orphan', 1, 1)")
          .run(),
      /constraint/i,
    )
  })

  test('foreign keys are enforced', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    assert.throws(
      () =>
        db
          .prepare(
            "insert into projects (id, owner_account_id, name, created_at, updated_at) values ('p1', 'missing', 'Test', 1, 1)",
          )
          .run(),
      /foreign key/i,
    )
  })

  test('an unknown plan or a negative credit count is refused', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    assert.throws(
      () =>
        db
          .prepare(
            "insert into accounts (id, email, email_normalized, created_at, plan, allowance_anchor_day) values ('a1', 'a@example.com', 'a@example.com', 1, 'gold', 1)",
          )
          .run(),
      /constraint/i,
    )

    assert.throws(
      () =>
        db
          .prepare(
            "insert into accounts (id, email, email_normalized, created_at, credits, allowance_anchor_day) values ('a2', 'b@example.com', 'b@example.com', 1, -1, 1)",
          )
          .run(),
      /constraint/i,
    )
  })

  test('an organization needs at least three seats and one owner', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    db.prepare(
      "insert into accounts (id, email, email_normalized, created_at, allowance_anchor_day) values ('owner', 'o@example.com', 'o@example.com', 1, 1)",
    ).run()
    db.prepare(
      "insert into accounts (id, email, email_normalized, created_at, allowance_anchor_day) values ('member', 'm@example.com', 'm@example.com', 1, 1)",
    ).run()

    assert.throws(
      () =>
        db
          .prepare(
            "insert into organizations (id, name, owner_account_id, seats, allowance_anchor_day, created_at) values ('o1', 'Studio', 'owner', 2, 1, 1)",
          )
          .run(),
      /constraint/i,
    )

    db.prepare(
      "insert into organizations (id, name, owner_account_id, seats, allowance_anchor_day, created_at) values ('o1', 'Studio', 'owner', 3, 1, 1)",
    ).run()
    db.prepare(
      "insert into organization_members (organization_id, account_id, role, joined_at) values ('o1', 'owner', 'owner', 1)",
    ).run()
    assert.throws(
      () =>
        db
          .prepare(
            "insert into organization_members (organization_id, account_id, role, joined_at) values ('o1', 'member', 'owner', 1)",
          )
          .run(),
      /unique/i,
    )
  })
})
