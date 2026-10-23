-- Email opt-outs, one row per address and kind (Email.rules).
--
-- A person may turn off invitations, receipts that are not for a payment they
-- made, and admin notices. A magic link and a password reset can never be
-- turned off, and a receipt for a payment the recipient made is always sent;
-- the service enforces both rules, so the table itself stays simple.
--
-- An address is stored normalized (trimmed and lower-cased), because that is
-- how two sends are known to reach the same person. Nothing about a project
-- is kept here.

create table email_optouts (
  email_normalized text not null
    check (length(email_normalized) > 3 and email_normalized = lower(email_normalized)),
  kind text not null
    check (kind in ('magic_link', 'invitation', 'receipt', 'admin_notice')),
  opted_out_at integer not null check (opted_out_at >= 0),
  primary key (email_normalized, kind)
);
