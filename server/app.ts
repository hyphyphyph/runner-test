// Assemble a server from its parts.

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type { Ctx } from './context.ts'
import { all, openDb } from './db.ts'
import { Settings } from './settings.ts'
import { DomainChecker } from './domain/check.ts'
import type { Sources } from './domain/check.ts'
import { Registries, networkSources } from './domain/sources.ts'
import { AnthropicProvider, DemoProvider } from './model.ts'
import type { ModelProvider } from './model.ts'
import { ConsoleTransport, HttpTransport, Mailer } from './email.ts'
import type { Transport } from './email.ts'
import { Live } from './live.ts'
import { Alerts } from './alerts.ts'
import { handleApi } from './routes.ts'
import { purge } from './account.ts'

export interface AppOptions {
  dbFile: string
  secret: string
  baseUrl: string
  dev?: boolean
  staticDir?: string | null
  sources?: Sources
  knownTld?: (tld: string) => Promise<boolean>
  model?: ModelProvider
  transport?: Transport
  billingMode?: Ctx['billingMode']
}

export function createContext(o: AppOptions): Ctx {
  const db = openDb(o.dbFile)
  const settings = new Settings(db)
  const mail = new Mailer(
    db,
    o.transport ??
      (process.env.NT_EMAIL_KEY ? new HttpTransport(process.env.NT_EMAIL_KEY, process.env.NT_EMAIL_FROM ?? 'NameTempest <hello@nametempest.com>') : new ConsoleTransport()),
  )
  const alerts = new Alerts(db, (alert) => {
    const operators = all<{ email: string }>(db, 'select email from accounts where operator = 1 and deleted_at is null')
    for (const op of operators) {
      mail.queue(op.email, 'operator-alert', `Alert: ${alert.part} is failing`, [
        `The part "${alert.part}" failed ${alert.failures} times since ${new Date(alert.began_at).toUTCString()}.`,
        `Reason: ${alert.reason}`,
        `See the admin interface: ${o.baseUrl}/#/admin`,
      ])
    }
  })
  const registries = new Registries()
  let ctxRef: Ctx | null = null
  const sources =
    o.sources ??
    networkSources(registries, () => ctxRef?.settings.config().paidLookup?.url ?? null)
  const checker = new DomainChecker(db, sources, {
    freshnessMs: () => settings.num('domain.freshnessMinutes') * 60_000,
    onFailure: (step, reason, detail) => alerts.failed('lookup:' + step, 'lookup', null, reason, detail),
  })
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const real: ModelProvider | null = anthropicKey ? new AnthropicProvider(anthropicKey) : null
  const demo = new DemoProvider()
  const modelFor = (model: string): ModelProvider => {
    if (o.model) return o.model
    if (model === 'demo' || !real) return demo
    return real
  }
  const billingMode =
    o.billingMode ?? (process.env.STRIPE_SECRET_KEY ? 'stripe' : process.env.NT_BILLING === 'fake' ? 'fake' : 'off')
  const ctx: Ctx = {
    db,
    settings,
    checker,
    knownTld: o.knownTld ?? ((tld) => registries.knownTld(tld)),
    modelFor,
    mail,
    live: new Live(),
    alerts,
    secret: o.secret,
    baseUrl: o.baseUrl.replace(/\/$/, ''),
    dev: o.dev ?? false,
    billingMode,
  }
  ctxRef = ctx
  return ctx
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

export function createApp(ctx: Ctx, staticDir: string | null): Server {
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    const path = (req.url ?? '/').split('?')[0]
    if (path.startsWith('/api/')) return handleApi(ctx, req, res)
    if (!staticDir) {
      res.writeHead(404).end()
      return
    }
    // Static files from the build, with the app shell for every other path.
    const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '')
    let file = join(staticDir, safe)
    if (!file.startsWith(staticDir)) file = join(staticDir, 'index.html')
    try {
      const st = await stat(file)
      if (st.isDirectory()) file = join(file, 'index.html')
    } catch {
      file = join(staticDir, 'index.html')
    }
    try {
      const body = await readFile(file)
      const type = TYPES[extname(file)] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(type.startsWith('text/html')
          ? { 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" }
          : {}),
      })
      res.end(body)
    } catch {
      res.writeHead(404).end('Not found')
    }
  })
  return server
}

export function startJobs(ctx: Ctx): () => void {
  ctx.mail.start()
  const t = setInterval(() => purge(ctx), 60 * 60 * 1000)
  t.unref()
  purge(ctx)
  return () => {
    clearInterval(t)
    ctx.mail.stop()
  }
}
