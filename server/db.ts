// Storage. One SQLite file holds the stored work, the counters, the settings
// and the audit records (StoredWork). Card data and readable passwords or
// network addresses are never written here.

import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'

export type Db = DatabaseSync

const SCHEMA = `
create table if not exists devices (
  id text primary key,
  created_at integer not null,
  anchor_day integer not null
);

create table if not exists accounts (
  id text primary key,
  email text not null unique,
  password_hash text,
  created_at integer not null,
  anchor_day integer not null,
  operator integer not null default 0,
  plan text not null default 'free',
  plan_active integer not null default 0,
  stripe_customer text,
  stripe_subscription text,
  credits integer not null default 0,
  email_prefs text not null default '{}',
  deleted_at integer,
  purge_at integer
);

create table if not exists sessions (
  token_hash text primary key,
  account_id text not null,
  created_at integer not null
);

create table if not exists magic_links (
  token_hash text primary key,
  email text not null,
  created_at integer not null,
  expires_at integer not null,
  used_at integer,
  replaced integer not null default 0,
  next text
);

create table if not exists orgs (
  id text primary key,
  name text not null,
  owner_id text not null,
  seats integer not null,
  plan_active integer not null default 0,
  stripe_subscription text,
  credits integer not null default 0,
  anchor_day integer not null,
  created_at integer not null
);

create table if not exists org_members (
  org_id text not null,
  account_id text not null unique,
  role text not null,
  joined_at integer not null,
  primary key (org_id, account_id)
);

create table if not exists invites (
  id text primary key,
  org_id text not null,
  email text not null,
  token_hash text not null,
  created_at integer not null,
  accepted_at integer,
  revoked integer not null default 0
);

create table if not exists usage (
  subject text not null,
  period text not null,
  rounds integer not null default 0,
  revisions integer not null default 0,
  checks integer not null default 0,
  limit_rounds integer,
  limit_revisions integer,
  limit_checks integer,
  limit_plan text,
  primary key (subject, period)
);

create table if not exists network_usage (
  ip_hash text not null,
  month text not null,
  rounds integer not null default 0,
  primary key (ip_hash, month)
);

create table if not exists projects (
  id text primary key,
  device_id text,
  account_id text,
  org_id text,
  shared integer not null default 0,
  name text not null,
  description text not null default '',
  industry text not null default '',
  style text not null default '{}',
  rounds integer not null default 0,
  used_rounds integer not null default 0,
  used_revisions integer not null default 0,
  used_checks integer not null default 0,
  used_credits integer not null default 0,
  conflict_with text,
  offered_from text,
  created_at integer not null,
  updated_at integer not null
);

create table if not exists candidates (
  id text primary key,
  project_id text not null,
  name text not null,
  name_key text not null,
  reason text not null,
  style text not null,
  domain text,
  domain_status text not null default 'unchecked',
  domain_reason text,
  checked_at integer,
  status text not null default 'candidate',
  round integer not null,
  added_by text,
  changed_by text,
  created_at integer not null,
  unique (project_id, name_key)
);

create table if not exists notes (
  id text primary key,
  project_id text not null,
  candidate_id text,
  body text not null,
  author text,
  version integer not null default 1,
  conflict_of text,
  updated_at integer not null
);

create table if not exists domain_cache (
  domain text primary key,
  status text not null,
  source text not null,
  checked_at integer not null
);

create table if not exists settings (
  key text primary key,
  value text not null,
  last_valid text
);

create table if not exists audit (
  id integer primary key autoincrement,
  at integer not null,
  operator text,
  action text not null,
  target text,
  old_value text,
  new_value text,
  reason text
);

create table if not exists failures (
  id integer primary key autoincrement,
  at integer not null,
  part text not null,
  action text not null,
  subject text,
  reason text not null,
  detail text
);

create table if not exists alerts (
  id integer primary key autoincrement,
  part text not null,
  began_at integer not null,
  last_at integer not null,
  failures integer not null,
  people text not null default '[]',
  reason text not null,
  detail text,
  raises integer not null default 1,
  emailed integer not null default 0,
  dismissed_at integer
);

create table if not exists unavailable (
  part text primary key,
  at integer not null,
  operator text
);

create table if not exists outbox (
  id text primary key,
  to_addr text not null,
  kind text not null,
  subject text not null,
  body text not null,
  created_at integer not null,
  sent_at integer,
  attempts integer not null default 0,
  next_at integer not null,
  last_error text
);

create table if not exists payments (
  id text primary key,
  account_id text,
  kind text not null,
  amount integer,
  created_at integer not null
);

create index if not exists idx_candidates_project on candidates(project_id);
create index if not exists idx_notes_project on notes(project_id);
create index if not exists idx_projects_device on projects(device_id);
create index if not exists idx_projects_account on projects(account_id);
create index if not exists idx_projects_org on projects(org_id);
`

export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 3000;')
  db.exec(SCHEMA)
  return db
}

export function id(prefix = ''): string {
  return prefix + randomBytes(12).toString('base64url')
}

export function token(): string {
  return randomBytes(32).toString('base64url')
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('begin immediate')
  try {
    const out = fn()
    db.exec('commit')
    return out
  } catch (e) {
    db.exec('rollback')
    throw e
  }
}

type Row = Record<string, unknown>

export function one<T = Row>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined
}

export function all<T = Row>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[]
}

export function run(db: Db, sql: string, ...params: unknown[]): number {
  return Number(db.prepare(sql).run(...(params as never[])).changes)
}
