# NameTempest

NameTempest is a web application that helps a person find a company name. This
repository holds the browser app, the API server and the database.

The product specification lives in `strataglyph-spec/`. It is not part of the
code and is never committed.

## Requirements

- Node.js 24 or newer
- npm

## Run it

```sh
npm install
npm run dev
```

`npm run dev` starts both processes:

- the Vite page on <http://localhost:5173>
- the API on <http://localhost:8787>

Vite proxies `/api` to the API, so the page and the API share one origin.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Start Vite and the API together |
| `npm run dev:client` | Start Vite alone |
| `npm run dev:server` | Start the API alone, restarting on a change |
| `npm run typecheck` | Type check the browser, the server and the tests |
| `npm test` | Run the unit tests, then the integration tests |
| `npm run test:unit` | Run the unit tests |
| `npm run test:integration` | Run the integration tests |
| `npm run build` | Type check and build the browser app |
| `npm start` | Start the API from source |
| `npm run preview` | Preview the built browser app |

## Layout

```
server/              the API process
  main.ts            entry point: open the database, listen, close cleanly
  app.ts             the HTTP routes
  db.ts              opening the database and applying migrations
  migrations/        numbered SQL migrations, applied in order
  settings.ts        operator limit settings, defaults and change record
  style-lists.ts     the operator's style, tone and ending pick lists
  allowance.ts       counters, monthly refresh, atomic spend and reservations
  version.ts         version read from package.json
shared/              code shared by the server and the browser
  api.ts             the API contract: request and response types
  client.ts          the typed fetch client
  style.ts           the style fields, shipped lists and offered-ending rules
src/                 the browser app
  main.ts            the naming workspace: brief, generate control and candidates
  style-form.ts      the six-field style form and the chosen-style summary
  local/             the anonymous identity, allowance and browser-local projects
    allowance.ts     the free allowance left, in one place
    types.ts         the stored-work shapes
    workspace.ts     the local store and its project rules
    memory-storage.ts  a fallback when localStorage is unavailable
tests/
  unit/              fast tests with an in-memory database or storage
  integration/       tests against a real server socket and a real file database
scripts/dev.mjs      starts Vite and the API together
.github/workflows/   continuous integration
```

## The naming workspace

The page opens on the naming workspace itself. A browser with no project gets
one empty `Untitled project`, so there is no separate create-project screen.
The project switcher sits in the sidebar, with a compact selector and a list
that shows each project's name counts.

The workspace holds:

- a required company description and an optional industry or category,
  saved in this browser as the person writes
- the optional six-field style form that shapes the next round
- a Generate names control, shown with the candidate area it fills
- an empty candidate area on the first visit
- a sticky remaining-allowance slot in the top bar, showing rounds, revisions
  and checks left this month

The shipped free allowance values (5 rounds, 3 revisions and 36 checks) live
in `src/local/allowance.ts` until the operator settings route reaches the
browser. A later work item connects generation to the control; for now a
valid submission saves the brief, says plainly that no round ran, and spends
nothing. Every customer-facing string uses `NameTempest` or `nametempest.com`.

### The style form

The six fields are naming style, tone, length, things to include, things to
avoid and preferred endings. Every field starts empty and may stay empty; a
round runs on the description alone. The chosen style is saved in the project
document and shown above the candidate list.

The naming style and tone choices and the ending pick list are operator
lists, not values typed into the form. The browser reads them from
`GET /api/style-lists` and falls back to the shipped lists in `shared/style.ts`
when the server cannot answer. The ending pick list is filtered to endings
that pass `DomainCheck.offeredEndings`. Preferred endings are checkboxes: a
tick saves a preference and never ticks a domain check. The free-text fields
are sent to the model as data, never as instructions. A style change applies
to the next round only and never rewrites a name already on the list.

## Browser-local projects

With no sign-in the browser makes an anonymous identity and keeps every
project in `localStorage`. No email address or password is involved. The
identity has its own monthly counters for rounds, revisions and checks, and
each project keeps the usage spent on it as well.

`src/local/workspace.ts` stores:

- one key for the anonymous identity
- one key for the order the projects are shown in
- one key for the project currently on screen
- one key for each project, holding that project's description, style,
  candidates, suggested endings, domain results, ticked checks, rejected
  names, notes and usage

A project document is self-contained and records the identity that owns it.
Reading, changing or deleting a project therefore touches only that project's
key, so switching projects cannot mix their names, notes or results. Deleting
a project removes its key and its entry in the list. A damaged project is
skipped rather than being allowed to break the others.

Projects are shown in creation order. A new project is named `Untitled
project`, then `Untitled project 2`, and so on, until the person renames it.
A project name is trimmed and may not be empty.

If the browser refuses `localStorage`, the page still runs against an
in-memory store and says plainly that the work will disappear when the tab
closes.

## Database

The database is one SQLite file, opened through Node's built-in `node:sqlite`.
There is no native module to build.

Migrations are the numbered `.sql` files in `server/migrations/`. The server
applies every migration that the database has not recorded in
`schema_migrations`, inside a transaction, before it opens its port. The same
function runs in the tests. A new migration is a new file with the next
number; an applied migration is never edited.

The database file defaults to `data/nametempest.db`, which git ignores. Set
`NT_DB` to use another file, or to `:memory:` for a throwaway database.

### Operator settings

`server/settings.ts` holds the fixed set of limit settings, the shipped
defaults and the code that reads and changes them. The values live in the
`settings` table and every change appends a row to `setting_changes` with the
setting, the old and new value, the time and the operator.

A write accepts only a positive whole number, and the batch size is refused
below five. A value is read when a counted action starts, so a change applies
to the next action and never rewrites work already spent. If a stored value is
missing or damaged, the last valid value stays in use and then the shipped
default, so a bad setting never blocks a person.

### Allowance counters

`server/allowance.ts` owns the rounds, revisions and checks counters for a
device, an account or a Studio organization. `shared/allowance.ts` holds the
arithmetic both the server and the browser use, so the two cannot disagree
about a month or a cost.

- A counter row is kept for one period. The period begins on the day of the
  first visit, clamped to the last day of a shorter month, and is named
  `YYYY-MM` after the month it began in. A new period is a new row; an old
  month is never rewritten.
- A device row is made on its first counted action, which fixes its refresh
  day. An account reads the anchor day from its account row. An active plan
  uses the plan's counters; a device and a free account use the free counters.
- `spend` checks every counter in the cost and takes the whole cost in one
  `begin immediate` transaction. A short counter refuses the whole action and
  takes nothing, including when two callers run at the same moment on separate
  connections or processes.
- `reserve` takes a whole multi-pair or multi-counter cost and writes a
  reservation row. `settle` keeps what the action answered and gives the rest
  back. `release` gives the whole cost back for a failed or stopped action.
  Closing a reservation twice is harmless, and a reservation survives a
  restart.
- The first counted action of a period records the limits in use. Raising a
  setting can apply at once; lowering it waits for the next period, so an
  allowance already shown for the month is not taken away mid-month.
- `AllowanceError` carries the counter, the amount needed and the amount that
  remains, so a gate message can say exactly what ran out.

The browser keeps the same counters on its anonymous identity. A spend, a
reserve, a settle and a release are synchronous reads and writes of one stored
identity document, so they are one step in the page. Held costs are stored
with the identity and survive a reload.

The account and organization counters are ready for the sign-in, billing and
organization work items. No unauthenticated API route exposes them; the
routes that name a subject arrive with the code that authenticates it.

### Privacy rules in the schema

The schema follows the specification's StoredWork anchor:

- no card number, security code or other payment detail has a column; the
  payment provider holds them
- a password is kept only as `password_hash`, a one-way hash
- a network address is kept only as `network_hash`, a one-way hash for the
  current month
- a session token, a magic link and a password reset link are kept only as
  hashes

`tests/unit/schema.test.ts` reads every column from the migrated schema and
fails if a readable password, a network address or a payment field appears.

## API

### `GET /api/health`

`GET /health` answers the same report without the `/api` prefix.

```json
{
  "status": "ok",
  "service": "nametempest",
  "version": "0.1.0",
  "uptimeSeconds": 12,
  "time": "2026-10-23T05:00:00.000Z",
  "database": { "status": "ok", "migrations": 1 }
}
```

The status is `ok` with HTTP 200 when the database answers. It is `degraded`
with HTTP 503 when the database does not, so a health check can act on it.

Every error is JSON:

```json
{ "error": { "code": "not_found", "message": "No API route matches that path." } }
```

### `GET /api/style-lists`

Returns the pick lists behind the style form:

```json
{
  "namingStyles": [{ "id": "descriptive", "label": "Descriptive" }],
  "tones": [{ "id": "playful", "label": "Playful" }],
  "endings": ["com", "io", "studio"],
  "offeredEndings": ["com", "io", "studio"]
}
```

`endings` is the operator's ending pick list, already filtered to endings
that pass `DomainCheck.offeredEndings`. `offeredEndings` is the wider set
that list may draw from. The shipped lists live in `shared/style.ts`. An
operator change is made through `StyleListStore` in `server/style-lists.ts`;
the admin route that calls it arrives with the admin interface and its
operator authentication.

### Typed client

`shared/api.ts` holds the contract. Add a route to `ApiContract` there before
calling it. `shared/client.ts` builds every call from that contract, so a route
outside the contract fails `npm run typecheck` and the server builds its answer
from the same types. The browser imports the same client the integration tests
use.

## Tests

The test runner is Node's built-in `node:test`; there is no test framework to
install. Tests run against the TypeScript source directly, using Node's type
stripping.

- Unit tests use an in-memory database or in-memory storage and cover
  migrations, constraints, stored work, the schema privacy rules, the
  browser-local projects, the allowance spend and reserve rules, and races
  across separate database connections.
- Integration tests start a real server on a random port with a real SQLite
  file, then call it with the shared typed client and with raw `fetch` for the
  error cases.

The CI workflow in `.github/workflows/ci.yml` installs dependencies, type
checks, runs the unit tests, runs the integration tests separately, and builds
the browser app.

## Environment

| Name | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | API port |
| `HOST` | `127.0.0.1` | API bind address |
| `NT_DB` | `data/nametempest.db` | SQLite file, or `:memory:` |
| `VITE_PORT` | `5173` | Vite dev server port |
