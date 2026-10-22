// The database: one SQLite file, opened once, with its migrations applied
// before the server starts. See Data.StoredWork for what is kept here.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

export interface Migration {
  /** The number at the start of the file name, such as "0001". */
  version: string
  /** The whole file name, kept for error messages. */
  name: string
  sql: string
}

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/** Read the migration files in order. Throws when none exist or a number repeats. */
export function loadMigrations(directory = migrationsDirectory): Migration[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))

  if (names.length === 0) throw new Error(`No migrations found in ${directory}.`)

  const seen = new Set<string>()
  return names.map((name) => {
    const version = name.slice(0, name.indexOf('_'))
    if (!/^\d+$/.test(version)) throw new Error(`Migration ${name} must start with a number and an underscore.`)
    if (seen.has(version)) throw new Error(`Migration version ${version} is used more than once.`)
    seen.add(version)

    const sql = readFileSync(join(directory, name), 'utf8').trim()
    if (sql.length === 0) throw new Error(`Migration ${name} is empty.`)

    return { version, name, sql }
  })
}

/** Apply every migration that the database has not recorded yet. */
export function migrate(db: Db, directory = migrationsDirectory): number {
  db.exec(`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      applied_at integer not null
    )
  `)

  const appliedRows = db.prepare('select version from schema_migrations').all() as Array<{ version: string }>
  const applied = new Set(appliedRows.map((row) => row.version))
  const migrations = loadMigrations(directory)

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue

    db.exec('begin immediate')
    try {
      db.exec(migration.sql)
      db.prepare('insert into schema_migrations (version, name, applied_at) values (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      )
      db.exec('commit')
    } catch (error) {
      try {
        db.exec('rollback')
      } catch {
        // The rollback failed too; the migration error is the useful one.
      }
      throw new Error(`Migration ${migration.name} failed.`, { cause: error })
    }
  }

  return countMigrations(db)
}

/** How many migrations this database has recorded. */
export function countMigrations(db: Db): number {
  const row = db.prepare('select count(*) as count from schema_migrations').get() as { count: number } | undefined
  return row?.count ?? 0
}

/**
 * Open a database and bring it up to date.
 *
 * A file path creates or opens that file; ":memory:" gives a throwaway
 * database for a unit test.
 */
export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file)
  try {
    db.exec('pragma foreign_keys = on')
    db.exec('pragma busy_timeout = 5000')
    if (file !== ':memory:') db.exec('pragma journal_mode = wal')
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
