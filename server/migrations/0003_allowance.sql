-- Allowance counters: the limits a period was shown with, and held costs.
--
-- FreeAllowance.spend says a cost is checked and taken in one step. The
-- counters row already holds what was spent this period. These extra columns
-- freeze the limits that were in use when the period first counted, so a
-- later operator change applies to the next counted action without rewriting
-- an allowance already shown for the month in progress.
--
-- A reservation is a whole cost taken before a multi-pair action runs. The
-- action settles the pairs it answered and gives the rest back, or releases
-- the whole cost when it fails. The reservation row is what makes that refund
-- survive a restart or a second server process.

alter table allowance_counters add column plan text;
alter table allowance_counters add column limit_rounds integer;
alter table allowance_counters add column limit_revisions integer;
alter table allowance_counters add column limit_checks integer;

create table allowance_reservations (
  id text primary key,
  subject_kind text not null check (subject_kind in ('device', 'account', 'organization')),
  subject_id text not null,
  period text not null,
  rounds integer not null default 0 check (rounds >= 0),
  revisions integer not null default 0 check (revisions >= 0),
  checks integer not null default 0 check (checks >= 0),
  remaining_rounds integer not null default 0 check (remaining_rounds >= 0),
  remaining_revisions integer not null default 0 check (remaining_revisions >= 0),
  remaining_checks integer not null default 0 check (remaining_checks >= 0),
  status text not null default 'held' check (status in ('held', 'settled', 'released')),
  project_id text,
  created_at integer not null,
  updated_at integer not null
);

create index allowance_reservations_by_subject
  on allowance_reservations (subject_kind, subject_id, period, status);
