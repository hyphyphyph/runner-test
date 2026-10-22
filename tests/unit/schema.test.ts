import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openDatabase } from '../../server/db.ts'
import type { Db } from '../../server/db.ts'

interface Column {
  table: string
  column: string
  type: string
}

function allColumns(db: Db): Column[] {
  const tables = db
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all() as Array<{ name: string }>

  return tables.flatMap(({ name }) => {
    const rows = db.prepare(`pragma table_info("${name.replaceAll('"', '""')}")`).all() as Array<{
      name: string
      type: string
    }>
    return rows.map((row) => ({ table: name, column: row.name, type: row.type }))
  })
}

describe('stored work schema', () => {
  test('every table named by StoredWork exists', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const tables = new Set(
      (db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    )

    for (const name of [
      'accounts',
      'devices',
      'organizations',
      'organization_members',
      'projects',
      'candidates',
      'candidate_endings',
      'domain_results',
      'pending_checks',
      'rejected_names',
      'notes',
      'project_usage',
      'allowance_counters',
      'network_counters',
    ]) {
      assert.ok(tables.has(name), `missing table ${name}`)
    }
  })

  test('a project keeps its inputs, style and preferred ending', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    db.prepare("insert into devices (id, created_at, allowance_anchor_day) values ('d1', 1, 1)").run()
    db.prepare(
      `insert into projects
        (id, device_id, name, description, industry, style, preferred_ending, created_at, updated_at)
       values ('p1', 'd1', 'Acme', 'We build, quote and test things.', 'software', '{"tone":"warm"}', 'studio', 1, 1)`,
    ).run()

    const row = db
      .prepare("select description, style, preferred_ending from projects where id = 'p1'")
      .get() as { description: string; style: string; preferred_ending: string }
    assert.equal(row.description, 'We build, quote and test things.')
    assert.deepEqual(JSON.parse(row.style), { tone: 'warm' })
    assert.equal(row.preferred_ending, 'studio')
  })

  test('candidates, suggested endings, results, ticks and rejections are kept', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    db.prepare("insert into devices (id, created_at, allowance_anchor_day) values ('d1', 1, 1)").run()
    db.prepare("insert into projects (id, device_id, name, created_at, updated_at) values ('p1', 'd1', 'Acme', 1, 1)").run()
    db.prepare(
      `insert into candidates (id, project_id, name, reason, style_tag, created_at)
       values ('c1', 'p1', 'Quillstead', 'Evokes writing and a settled place.', 'warm', 1)`,
    ).run()
    db.prepare(
      `insert into candidate_endings (id, candidate_id, ending, reason, created_at)
       values ('e1', 'c1', 'io', 'Short and common with software.', 1)`,
    ).run()
    db.prepare(
      `insert into domain_results (id, project_id, candidate_id, name, ending, status, checked_at)
       values ('r1', 'p1', 'c1', 'Quillstead', 'com', 'available', 10)`,
    ).run()
    db.prepare(
      `insert into pending_checks (id, project_id, candidate_id, name, ending, requested_at)
       values ('pc1', 'p1', 'c1', 'Quillstead', 'io', 11)`,
    ).run()
    db.prepare(
      "insert into rejected_names (project_id, name, rejected_at) values ('p1', 'Oldname', 12)",
    ).run()

    assert.equal((db.prepare('select count(*) as count from candidates').get() as { count: number }).count, 1)
    assert.equal((db.prepare('select count(*) as count from candidate_endings').get() as { count: number }).count, 1)
    assert.equal((db.prepare('select count(*) as count from domain_results').get() as { count: number }).count, 1)
    assert.equal((db.prepare('select count(*) as count from pending_checks').get() as { count: number }).count, 1)
    assert.equal((db.prepare('select count(*) as count from rejected_names').get() as { count: number }).count, 1)
  })

  test('a note keeps commas, quotes, line breaks and non-ASCII text whole', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    db.prepare("insert into devices (id, created_at, allowance_anchor_day) values ('d1', 1, 1)").run()
    db.prepare("insert into projects (id, device_id, name, created_at, updated_at) values ('p1', 'd1', 'Acme', 1, 1)").run()

    const body = 'Warm, "honest" voice.\nSecond line — Zoë likes it.'
    db.prepare(
      `insert into notes (id, project_id, name, body, created_at, updated_at)
       values ('n1', 'p1', 'Quillstead', ?, 1, 1)`,
    ).run(body)

    const row = db.prepare("select body from notes where id = 'n1'").get() as { body: string }
    assert.equal(row.body, body)
  })

  test('usage and allowance counters are kept per project and per subject', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    db.prepare("insert into devices (id, created_at, allowance_anchor_day) values ('d1', 1, 1)").run()
    db.prepare("insert into projects (id, device_id, name, created_at, updated_at) values ('p1', 'd1', 'Acme', 1, 1)").run()
    db.prepare(
      "insert into project_usage (project_id, rounds, revisions, checks, credits, updated_at) values ('p1', 2, 1, 7, 0, 1)",
    ).run()
    db.prepare(
      `insert into allowance_counters (subject_kind, subject_id, period, rounds, revisions, checks, updated_at)
       values ('device', 'd1', '2026-10', 2, 1, 7, 1)`,
    ).run()

    const usage = db.prepare("select rounds, checks from project_usage where project_id = 'p1'").get() as {
      rounds: number
      checks: number
    }
    assert.equal(usage.rounds, 2)
    assert.equal(usage.checks, 7)

    const counters = db
      .prepare("select rounds, checks from allowance_counters where subject_kind = 'device' and subject_id = 'd1'")
      .get() as { rounds: number; checks: number }
    assert.equal(counters.rounds, 2)
    assert.equal(counters.checks, 7)
  })

  test('a domain result accepts only the four statuses and a bare lower-case ending', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    db.prepare("insert into devices (id, created_at, allowance_anchor_day) values ('d1', 1, 1)").run()
    db.prepare("insert into projects (id, device_id, name, created_at, updated_at) values ('p1', 'd1', 'Acme', 1, 1)").run()

    for (const status of ['available', 'taken', 'unknown', 'not_valid']) {
      db.prepare(
        `insert into domain_results (id, project_id, name, ending, status, checked_at)
         values (?, 'p1', 'Quillstead', 'com', ?, 1)`,
      ).run(`r-${status}`, status)
    }

    assert.throws(
      () =>
        db
          .prepare(
            "insert into domain_results (id, project_id, name, ending, status, checked_at) values ('bad', 'p1', 'Quillstead', 'com', 'maybe', 1)",
          )
          .run(),
      /constraint/i,
    )
    assert.throws(
      () =>
        db
          .prepare(
            "insert into domain_results (id, project_id, name, ending, status, checked_at) values ('bad2', 'p1', 'Quillstead', '.com', 'available', 1)",
          )
          .run(),
      /constraint/i,
    )
  })
})

describe('schema privacy', () => {
  test('no payment detail has a column anywhere', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const paymentColumns = allColumns(db).filter((column) =>
      /card|cvc|cvv|iban|payment|billing_address|security_code/i.test(column.column),
    )
    assert.deepEqual(
      paymentColumns.map((column) => `${column.table}.${column.column}`),
      [],
      'payment data belongs to the payment provider and must never be stored here',
    )
  })

  test('a password is kept only as password_hash', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const passwordColumns = allColumns(db).filter((column) => /password/i.test(column.column))
    assert.ok(passwordColumns.length > 0, 'an account must have somewhere for the one-way password hash')
    for (const column of passwordColumns) {
      assert.equal(column.column, 'password_hash')
    }
  })

  test('a network address is kept only as network_hash', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const columns = allColumns(db)
    const addressColumns = columns.filter((column) =>
      /(^|_)(ip|ip_address|network_address|remote_address|client_address|address)($|_)/i.test(column.column),
    )
    assert.deepEqual(
      addressColumns.map((column) => `${column.table}.${column.column}`),
      [],
      'a readable network address must never have a column',
    )
    assert.ok(columns.some((column) => column.table === 'network_counters' && column.column === 'network_hash'))
  })

  test('every stored secret is a one-way hash', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const secretColumns = allColumns(db).filter((column) => /token|secret|password/i.test(column.column))
    assert.ok(secretColumns.length >= 3)
    for (const column of secretColumns) {
      assert.match(column.column, /_hash$/)
      assert.equal(column.type.toLowerCase(), 'text')
    }
  })
})
