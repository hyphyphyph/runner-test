// Test helpers: a server on a free port with fake lookups and the demo
// model, and a small client with its own cookie jar (one browser each).

import type { AddressInfo } from 'node:net'
import { createApp, createContext } from '../server/app.ts'
import type { Ctx } from '../server/context.ts'
import type { Sources } from '../server/domain/check.ts'
import type { Transport } from '../server/email.ts'

export class MemoryTransport implements Transport {
  sent: { to: string; subject: string; body: string }[] = []
  async send(to: string, subject: string, body: string) {
    this.sent.push({ to, subject, body })
  }
}

// Domains listed in `taken` have name servers; everything else is free.
export function fakeSources(taken: Set<string>, opts: { rdapDown?: boolean } = {}): Sources & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async dns(d) {
      calls.push('dns:' + d)
      return taken.has(d)
    },
    async hasRdap() {
      return true
    },
    async rdap(d) {
      calls.push('rdap:' + d)
      if (opts.rdapDown) throw new Error('down')
      return taken.has(d) ? 'found' : 'notfound'
    },
    async whois(d) {
      calls.push('whois:' + d)
      return taken.has(d) ? 'registered' : 'nomatch'
    },
    paid: null,
  }
}

export interface TestServer {
  ctx: Ctx
  url: string
  mail: MemoryTransport
  close: () => Promise<void>
}

export async function startServer(sources: Sources = fakeSources(new Set(['takenname.com']))): Promise<TestServer> {
  const mail = new MemoryTransport()
  const ctx = createContext({
    dbFile: ':memory:',
    secret: 'test',
    baseUrl: 'http://test.local',
    dev: true,
    sources,
    knownTld: async () => true,
    transport: mail,
    billingMode: 'fake',
  })
  const server = createApp(ctx, null)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    ctx,
    url: `http://127.0.0.1:${port}`,
    mail,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

export class Browser {
  base: string
  jar = new Map<string, string>()
  ip: string
  constructor(base: string, ip = '10.0.0.1') {
    this.base = base
    this.ip = ip
  }
  private cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  async req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string; headers: Headers }> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        cookie: this.cookie(),
        'x-forwarded-for': this.ip,
        ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      },
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    })
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair.indexOf('=')
      const k = pair.slice(0, i)
      const v = pair.slice(i + 1)
      if (/Max-Age=0/.test(c)) this.jar.delete(k)
      else this.jar.set(k, v)
    }
    const text = await res.text()
    let parsed: any = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed, text, headers: res.headers }
  }
  get(path: string) {
    return this.req('GET', path)
  }
  post(path: string, body?: unknown) {
    return this.req('POST', path, body)
  }
  patch(path: string, body?: unknown) {
    return this.req('PATCH', path, body)
  }
  del(path: string) {
    return this.req('DELETE', path)
  }
}

export async function projectWithDescription(b: Browser, name = 'Bakery'): Promise<string> {
  const p = await b.post('/api/projects', { name })
  await b.patch(`/api/projects/${p.body.id}`, { description: 'A sourdough bakery in Lisbon selling bread, pastries and coffee' })
  return p.body.id
}
