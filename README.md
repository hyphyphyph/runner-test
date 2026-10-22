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
  version.ts         version read from package.json
shared/              code shared by the server and the browser
  api.ts             the API contract: request and response types
  client.ts          the typed fetch client
src/                 the browser app
tests/
  unit/              fast tests with an in-memory database
  integration/       tests against a real server socket and a real file database
scripts/dev.mjs      starts Vite and the API together
.github/workflows/   continuous integration
```

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

- Unit tests use an in-memory database and cover migrations, constraints,
  stored work and the schema privacy rules.
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
