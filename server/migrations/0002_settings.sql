-- Operator limit settings and the record of every change (Limits, Admin).
--
-- The set of settings is fixed by the specification; only their values
-- change. A value is stored as JSON text so a missing or malformed value can
-- be told apart from a valid one. last_valid holds the last value that
-- passed validation, so a corrupted value never blocks a person.
--
-- The shipped defaults are seeded here so the store is readable as soon as
-- the migration has run. The server also keeps the same values as code
-- defaults, for a row that is missing or whose last valid value is gone.

create table settings (
  key text primary key,
  value text not null,
  last_valid text
);

-- Every change records the setting, the old and new value, the time and the
-- operator. Rows are append-only; an admin change is never edited.
create table setting_changes (
  id integer primary key autoincrement,
  setting text not null,
  old_value integer not null,
  new_value integer not null,
  changed_at integer not null,
  operator text not null,
  reason text
);

create index setting_changes_by_setting on setting_changes (setting, changed_at);

insert into settings (key, value, last_valid) values
  ('free.rounds', '5', '5'),
  ('free.revisions', '3', '3'),
  ('free.checks', '36', '36'),
  ('round.batch', '12', '12'),
  ('pro.rounds', '60', '60'),
  ('pro.revisions', '40', '40'),
  ('pro.checks', '400', '400'),
  ('studio.rounds', '50', '50'),
  ('studio.revisions', '30', '30'),
  ('studio.checks', '300', '300'),
  ('level.quick.multiplier', '1', '1'),
  ('level.balanced.multiplier', '2', '2'),
  ('level.thorough.multiplier', '3', '3'),
  ('network.ceiling', '50', '50'),
  ('domain.freshnessMinutes', '1440', '1440');
