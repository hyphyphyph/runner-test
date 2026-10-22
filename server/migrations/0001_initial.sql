-- NameTempest initial schema.
--
-- This file holds the stored work described by the StoredWork anchor.
-- Conventions:
--   * every id is a text UUID made by the application
--   * every time is an integer number of milliseconds since the Unix epoch
--   * an ending is a bare lower-case label, such as "com" or "studio",
--     never a whole domain and never with a leading dot
--   * an allowance period is a text month, such as "2026-10"
--
-- Privacy rules enforced by the shape of this schema:
--   * there is no card number, security code or other payment detail, because
--     the payment provider holds them
--   * a password is kept only as password_hash, a one-way hash
--   * a network address is kept only as network_hash, a one-way hash for the
--     current month
-- The tests in tests/unit/schema.test.ts fail if a column breaks these rules.

-- A person with a sign-in, or the owner of an organization.
create table accounts (
  id text primary key,
  email text not null,
  email_normalized text not null unique,
  password_hash text,
  created_at integer not null,
  deleted_at integer,
  purge_at integer,
  plan text not null default 'free' check (plan in ('free', 'pro', 'studio')),
  plan_active integer not null default 0 check (plan_active in (0, 1)),
  credits integer not null default 0 check (credits >= 0),
  allowance_anchor_day integer not null check (allowance_anchor_day between 1 and 31)
);

-- A browser that works without an account (Accounts.anonymous).
create table devices (
  id text primary key,
  created_at integer not null,
  allowance_anchor_day integer not null check (allowance_anchor_day between 1 and 31)
);

-- A signed-in session. The token itself is never stored, only its hash.
create table auth_sessions (
  token_hash text primary key,
  account_id text not null references accounts(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
);

-- A single-use sign-in or password-reset link, kept as a hash.
create table magic_links (
  token_hash text primary key,
  email text not null,
  purpose text not null check (purpose in ('sign_in', 'password_reset')),
  created_at integer not null,
  expires_at integer not null,
  used_at integer
);

-- A Studio organization: the seats, the owner, the plan and the shared work.
create table organizations (
  id text primary key,
  name text not null,
  owner_account_id text not null references accounts(id) on delete restrict,
  seats integer not null check (seats >= 3),
  plan text not null default 'studio' check (plan in ('free', 'pro', 'studio')),
  plan_active integer not null default 0 check (plan_active in (0, 1)),
  credits integer not null default 0 check (credits >= 0),
  allowance_anchor_day integer not null check (allowance_anchor_day between 1 and 31),
  created_at integer not null
);

-- Who sits in an organization, and in which role (Organizations.roles).
create table organization_members (
  organization_id text not null references organizations(id) on delete cascade,
  account_id text not null references accounts(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at integer not null,
  primary key (organization_id, account_id)
);

-- Exactly one owner for each organization.
create unique index one_owner_per_organization
  on organization_members (organization_id)
  where role = 'owner';

-- A naming project and its inputs (StoredWork.stored).
create table projects (
  id text primary key,
  owner_account_id text references accounts(id) on delete cascade,
  device_id text references devices(id) on delete cascade,
  organization_id text references organizations(id) on delete restrict,
  shared integer not null default 0 check (shared in (0, 1)),
  name text not null,
  description text not null default '',
  industry text not null default '',
  style text not null default '{}',
  preferred_ending text,
  created_at integer not null,
  updated_at integer not null,
  check (owner_account_id is not null or device_id is not null),
  check (shared = 0 or organization_id is not null)
);

create index projects_by_account on projects (owner_account_id);
create index projects_by_device on projects (device_id);
create index projects_by_organization on projects (organization_id);

-- Every candidate a round produced, with its reason and style tag.
create table candidates (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  reason text not null default '',
  style_tag text not null default '',
  suggested_by_model integer not null default 1 check (suggested_by_model in (0, 1)),
  round_number integer not null default 1 check (round_number >= 1),
  added_by_account_id text references accounts(id) on delete set null,
  created_at integer not null
);

create index candidates_by_project on candidates (project_id);
create index candidates_by_project_name on candidates (project_id, name);

-- Every ending the model suggested for a candidate, with its one-line reason.
create table candidate_endings (
  id text primary key,
  candidate_id text not null references candidates(id) on delete cascade,
  ending text not null check (length(ending) > 0 and ending = lower(ending) and ending not like '.%'),
  reason text not null default '',
  created_at integer not null,
  unique (candidate_id, ending)
);

-- Every domain result, kept as a name and ending pair with its status and
-- the time of its check. history is kept, so the newest row wins on display.
create table domain_results (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  candidate_id text references candidates(id) on delete set null,
  name text not null,
  ending text not null check (length(ending) > 0 and ending = lower(ending) and ending not like '.%'),
  status text not null check (status in ('available', 'taken', 'unknown', 'not_valid')),
  reason text,
  source text,
  checked_at integer not null,
  fresh_until integer
);

create index domain_results_by_project on domain_results (project_id);
create index domain_results_by_pair on domain_results (project_id, name, ending, checked_at);

-- The endings a person ticked for a check, including those not run yet.
create table pending_checks (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  candidate_id text references candidates(id) on delete cascade,
  name text not null,
  ending text not null check (length(ending) > 0 and ending = lower(ending) and ending not like '.%'),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'stopped', 'failed')),
  requested_at integer not null,
  started_at integer,
  completed_at integer,
  requested_by_account_id text references accounts(id) on delete set null
);

create index pending_checks_by_project on pending_checks (project_id);
create index pending_checks_by_status on pending_checks (project_id, status);

-- The names a person rejected.
create table rejected_names (
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  rejected_at integer not null,
  rejected_by_account_id text references accounts(id) on delete set null,
  primary key (project_id, name)
);

-- The notes a person wrote on a name. More than one row per name is allowed,
-- so two versions written at the same moment are never silently lost.
create table notes (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  candidate_id text references candidates(id) on delete set null,
  name text not null,
  body text not null,
  created_at integer not null,
  updated_at integer not null,
  updated_by_account_id text references accounts(id) on delete set null
);

create index notes_by_project_name on notes (project_id, name);

-- The usage spent on each project.
create table project_usage (
  project_id text primary key references projects(id) on delete cascade,
  rounds integer not null default 0 check (rounds >= 0),
  revisions integer not null default 0 check (revisions >= 0),
  checks integer not null default 0 check (checks >= 0),
  credits integer not null default 0 check (credits >= 0),
  updated_at integer not null
);

-- The allowance counters for a device, an account or an organization, one
-- row for each month. The subject is polymorphic, so this table has no
-- foreign key; deleting an account removes its rows in application code.
create table allowance_counters (
  subject_kind text not null check (subject_kind in ('device', 'account', 'organization')),
  subject_id text not null,
  period text not null,
  rounds integer not null default 0 check (rounds >= 0),
  revisions integer not null default 0 check (revisions >= 0),
  checks integer not null default 0 check (checks >= 0),
  updated_at integer not null,
  primary key (subject_kind, subject_id, period)
);

-- The looser ceiling per network address (ResetDefences). Only a one-way
-- hash of the address is kept, and only for the current month.
create table network_counters (
  network_hash text not null,
  period text not null,
  rounds integer not null default 0 check (rounds >= 0),
  revisions integer not null default 0 check (revisions >= 0),
  checks integer not null default 0 check (checks >= 0),
  updated_at integer not null,
  primary key (network_hash, period)
);
