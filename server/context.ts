// The services one running server shares.

import type { Db } from './db.ts'
import type { Settings } from './settings.ts'
import type { DomainChecker } from './domain/check.ts'
import type { ModelProvider } from './model.ts'
import type { Mailer } from './email.ts'
import type { Live } from './live.ts'
import type { Alerts } from './alerts.ts'

export interface Ctx {
  db: Db
  settings: Settings
  checker: DomainChecker
  // Whether a top level domain is in the root zone list.
  knownTld: (tld: string) => Promise<boolean>
  // The provider for a configured model name; "demo" is the local generator.
  modelFor: (model: string) => ModelProvider
  mail: Mailer
  live: Live
  alerts: Alerts
  secret: string
  baseUrl: string
  dev: boolean
  billingMode: 'stripe' | 'fake' | 'off'
}

// The top level domain the first version checks (DomainCheck.scope).
export const TLD = 'com'

export function unavailableParts(ctx: Ctx): Set<string> {
  const rows = ctx.db.prepare('select part from unavailable').all() as { part: string }[]
  return new Set(rows.map((r) => r.part))
}
