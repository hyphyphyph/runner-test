# NameTempest

NameTempest (nametempest.com) helps a person find a company name. They describe the company, an AI model suggests names over several rounds, and the app checks which names have a free .com domain.

## Run it

```sh
npm install
npm run build          # type-checks both sides and builds the site into dist/
npm start              # serves the API and dist/ on http://localhost:8787
```

For development, run `npm run server` (API on 8787) and `npm run dev` (Vite on 5173, which proxies `/api`).

Run the tests with `npm test`. They start a server with fake domain lookups and the built-in demo generator, so they need no network access and no keys.

Grant the operator role by hand: `node server/main.ts operator someone@example.com on`. Turn it off the same way with `off`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | The naming model. Without it, names come from a local demo generator. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments. Point a Stripe webhook at `/api/stripe/webhook`. |
| `NT_BILLING=fake` | Development only: purchases complete at once, with no payment. |
| `NT_EMAIL_KEY`, `NT_EMAIL_FROM`, `NT_EMAIL_URL` | A Resend-compatible email API. Without them, emails are printed to the console. |
| `NT_SECRET` | Required in production. Salts the network address hashes. |
| `NT_DB` | The SQLite file. Defaults to `data/nametempest.db`. |
| `NT_BASE_URL` | The public address, used in links inside emails. |
| `NT_TRUST_PROXY=1` | Read the client address from `X-Forwarded-For`. |
| `NT_PAID_LOOKUP_KEY` | A bearer key for the optional paid lookup service set in admin. |

The operator sets every limit, price, level model, style pick list and the paid lookup service in the admin interface at `#/admin`. None of these live in source files.

## Layout

- `server/`: Node with the built-in `node:sqlite`, no framework.
  - `allowance.ts`: counters, the monthly period, the gate, credits and the sign-in merge.
  - `rounds.ts`: generation, revision and domain checks. Each one is charged only after it succeeds.
  - `domain/`: the lookup chain. It goes DNS name servers, then RDAP, then WHOIS, then an optional paid service. It uses the IANA root zone and RDAP bootstrap files, a shared cache and a fresh confirmation before a name is shown as available.
  - `model.ts`: a structured model call through a forced tool, with checks on the reply's shape, plus the demo generator.
  - `auth.ts`, `orgs.ts`, `billing.ts`, `account.ts`, `admin.ts`, `alerts.ts`, `email.ts`, `live.ts`: the rest of the specification.
- `shared/`: code used by both sides: the domain spelling rule, export formats and types.
- `src/`: the browser app, in plain TypeScript and DOM with no framework.
- `tests/`: `node:test` unit and end-to-end API tests.

## Decisions where the specification leaves room

- **Credit cost per level.** The specification says a credit buys one Balanced round and that Thorough spends three credits. Balanced's round multiplier is 2, so "the same ratio as the multiplier" cannot hold as well. Credit cost is therefore its own operator setting per level, shipped as Quick 1, Balanced 1 and Thorough 3.
- **Batch sizes.** Balanced returns the batch setting (12). Quick returns 1.5 times that and Thorough 0.6 times, and no level returns fewer than 5.
- **Limit changes mid-month.** The limits shown at a person's first counted action in a month are kept for that month. An operator can raise them at once, but cannot lower them until the next month.
- **WHOIS and paid lookups** can prove a name taken. They never prove it free. Only a fresh RDAP not-found reply shows a name as available.
- **Domain checks.** A name with a fresh taken result is not looked up again, and confirming a fresh available result again spends nothing. Two names that map to one domain spend one check.
- **Anonymous work** is stored on the server under the browser's device cookie. It is reachable only from that browser, and clearing the browser loses it, as the specification describes.
- **The Studio allowance** is the Studio per-seat setting times the number of seats, shared by the organization.
- **Deletion.** A deleted account can be restored by signing in within 30 days. After that, an hourly job removes it and its work.
- **Magic links** expire after 15 minutes.
- **Alerts.** The repeat window for alerts is 10 minutes.
- **Open questions are not decided here:** prices, the email provider, hosting and the model behind each level. They are settings or environment variables.
