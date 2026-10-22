-- The pick lists behind the style form (Admin.style, Generation.styleRules).
--
-- The naming style and tone lists are choices the operator can add, rename
-- or remove. The ending pick list holds bare lower-case endings and is only
-- ever drawn from endings that pass DomainCheck.offeredEndings; the store
-- checks that rule before a row is written.
--
-- Removing a choice stops offering it. It never rewrites a project, because
-- a project keeps the style it already holds in its own style document.
--
-- The shipped lists are inserted by the store on first use, so the code and
-- the database cannot drift. style_list_meta records that seeding happened:
-- an operator may remove every choice from a list, and it must stay empty
-- rather than being seeded again.

create table style_list_options (
  list text not null check (list in ('namingStyle', 'tone')),
  id text not null,
  label text not null check (length(trim(label)) > 0),
  position integer not null check (position >= 0),
  primary key (list, id)
);

create table style_endings (
  ending text primary key
    check (length(ending) > 0 and ending = lower(ending) and ending not like '.%'),
  position integer not null check (position >= 0)
);

create table style_list_meta (
  key text primary key,
  value text not null
);

-- Every admin change keeps the old and new value, the time, the operator and
-- the reason. Rows are append-only, as Admin.audit says.
create table style_list_changes (
  id integer primary key autoincrement,
  list text not null check (list in ('namingStyle', 'tone', 'ending')),
  action text not null check (action in ('add', 'rename', 'remove')),
  option_id text not null,
  old_value text,
  new_value text,
  changed_at integer not null,
  operator text not null,
  reason text
);

create index style_list_changes_by_list on style_list_changes (list, changed_at);
