-- The offered endings, refreshed from public registry sources
-- (DomainCheck.offeredEndings, Admin.endings).
--
-- An ending may be suggested or ticked only when three facts hold together:
--   * it appears in the refreshed IANA root zone list
--   * the shipped lookup chain has a route that can answer both free and
--     taken for it (an RDAP service in the IANA bootstrap file)
--   * its registry's terms allow a hosted product to query it at this volume
--
-- The row keeps each fact separately, the reason when the ending is not
-- offered, and the registration query the bootstrap file gave. The offered
-- list is a query over this table; no part keeps its own copy.
--
-- `required_by_product` marks the ending the specification promises to offer
-- before the first refresh. Only .com carries it. The seed row lets the style
-- form work on a fresh database; the daily refresh replaces its facts from the
-- root zone list and the RDAP bootstrap file.

create table offered_endings (
  ending text primary key
    check (length(ending) > 0 and ending = lower(ending) and ending not like '.%'),
  in_root_zone integer not null check (in_root_zone in (0, 1)),
  route_answers_both integer not null check (route_answers_both in (0, 1)),
  terms_allow_hosted_queries integer not null check (terms_allow_hosted_queries in (0, 1)),
  required_by_product integer not null default 0 check (required_by_product in (0, 1)),
  offered integer not null check (offered in (0, 1)),
  reason_code text
    check (reason_code in ('not_in_root_zone', 'route_cannot_settle', 'terms_disallow')),
  reason text,
  registration_query_url text,
  source text not null default 'refresh',
  updated_at integer not null,
  -- An ending is offered only when all three facts hold, unless the product
  -- requires it.
  check (
    offered = 0
    or required_by_product = 1
    or (in_root_zone = 1 and route_answers_both = 1 and terms_allow_hosted_queries = 1)
  ),
  -- An ending that is not offered always records why.
  check (offered = 1 or (reason_code is not null and reason is not null))
);

create index offered_endings_by_offer on offered_endings (offered, ending);

-- What the last refresh did. A failed refresh keeps the last good rows and
-- records the error here, so a network problem never empties the list.
create table offered_endings_meta (
  key text primary key,
  value text not null
);

-- A registry terms decision. There is no public machine-readable source for
-- registry terms, so the product records a decision here when one is made.
-- A missing row means the shipped RDAP route is allowed by default; an
-- operator can record a refusal with its reason, and the next refresh applies
-- it to the ending.
create table registry_terms (
  ending text primary key
    check (length(ending) > 0 and ending = lower(ending) and ending not like '.%'),
  allows_hosted_queries integer not null check (allows_hosted_queries in (0, 1)),
  reason text,
  decided_at integer not null,
  decided_by text not null
);

-- The ending the specification promises, before the first refresh runs.
insert into offered_endings
  (ending, in_root_zone, route_answers_both, terms_allow_hosted_queries,
   required_by_product, offered, reason_code, reason, registration_query_url,
   source, updated_at)
values
  ('com', 1, 1, 1, 1, 1, null, null, null, 'required', 0);
