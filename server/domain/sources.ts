// The shipped lookup chain, which needs no subscription (DomainCheck.service,
// DomainCheck.registries). The list of top level domains and the RDAP
// service addresses come from IANA's public files, refreshed daily.

import { Resolver } from 'node:dns/promises'
import { connect } from 'node:net'
import { LookupError } from './check.ts'
import type { RdapReply, Sources } from './check.ts'

const ROOT_ZONE = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt'
const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json'
const DAY = 24 * 60 * 60 * 1000

export class Registries {
  private tlds: Set<string> | null = null
  private rdap = new Map<string, string>()
  private whois = new Map<string, string>()
  private loadedAt = 0
  private loading: Promise<void> | null = null

  async refresh(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const [zone, boot] = await Promise.all([
          fetch(ROOT_ZONE, { signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.text() : Promise.reject(r.status))),
          fetch(RDAP_BOOTSTRAP, { signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
        ])
        this.tlds = new Set(
          String(zone)
            .split('\n')
            .map((l) => l.trim().toLowerCase())
            .filter((l) => l && !l.startsWith('#')),
        )
        const map = new Map<string, string>()
        for (const [names, urls] of (boot as { services: [string[], string[]][] }).services) {
          const url = urls.find((u) => u.startsWith('https://')) ?? urls[0]
          for (const tld of names) map.set(tld.toLowerCase(), url.endsWith('/') ? url : url + '/')
        }
        this.rdap = map
        this.loadedAt = Date.now()
      } catch {
        // Keep the previous lists; the next check tries again.
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  private async fresh(): Promise<void> {
    if (Date.now() - this.loadedAt > DAY) await this.refresh()
  }

  async knownTld(tld: string): Promise<boolean> {
    await this.fresh()
    return this.tlds ? this.tlds.has(tld) : true
  }

  async rdapBase(tld: string): Promise<string | null> {
    await this.fresh()
    return this.rdap.get(tld) ?? null
  }

  async whoisServer(tld: string): Promise<string> {
    const known = this.whois.get(tld)
    if (known) return known
    const reply = await whoisQuery('whois.iana.org', tld)
    const m = /^whois:\s*(\S+)/im.exec(reply)
    if (!m) throw new LookupError('There is no WHOIS service for this registry.')
    this.whois.set(tld, m[1])
    return m[1]
  }
}

function whoisQuery(host: string, query: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 43 })
    let data = ''
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      reject(new LookupError('The WHOIS lookup took too long to answer.'))
    })
    socket.on('connect', () => socket.write(query + '\r\n'))
    socket.on('data', (d) => {
      data += d.toString('utf8')
      if (data.length > 200000) socket.destroy()
    })
    socket.on('end', () => resolve(data))
    socket.on('close', () => resolve(data))
    socket.on('error', (e) => reject(new LookupError('The WHOIS lookup failed.', e.message)))
  })
}

export function networkSources(registries: Registries, paidUrl: () => string | null): Sources {
  const resolver = new Resolver({ timeout: 2500, tries: 2 })
  return {
    async dns(domain) {
      try {
        const ns = await resolver.resolveNs(domain)
        return ns.length > 0
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'ENOTFOUND' || code === 'ENODATA') return false
        throw new LookupError('The name server lookup failed.', String(code))
      }
    },
    async hasRdap(tld) {
      return (await registries.rdapBase(tld)) !== null
    },
    async rdap(domain): Promise<RdapReply> {
      const tld = domain.slice(domain.lastIndexOf('.') + 1)
      const base = await registries.rdapBase(tld)
      if (!base) throw new LookupError('This registry has no registration query service.')
      let res: Response
      try {
        res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
          headers: { accept: 'application/rdap+json, application/json' },
          signal: AbortSignal.timeout(5000),
        })
      } catch (e) {
        throw new LookupError('The registration lookup did not answer.', String(e))
      }
      if (res.status === 404) return 'notfound'
      if (res.status === 429) throw new LookupError('The registry is limiting lookups right now. Try again in a few minutes.')
      if (!res.ok) throw new LookupError('The registration lookup failed.', 'HTTP ' + res.status)
      try {
        const body = (await res.json()) as { objectClassName?: string; ldhName?: string }
        if (body.objectClassName === 'domain' && typeof body.ldhName === 'string') return 'found'
        return 'malformed'
      } catch {
        return 'malformed'
      }
    },
    async whois(domain) {
      const tld = domain.slice(domain.lastIndexOf('.') + 1)
      const server = await registries.whoisServer(tld)
      // Verisign's server takes "domain <name>" to skip partial matches.
      const q = server.includes('verisign') ? 'domain ' + domain : domain
      const reply = await whoisQuery(server, q)
      if (/^\s*Domain Name:\s*\S+/im.test(reply)) return 'registered'
      if (/no match for|not found|no data found|no entries found/i.test(reply)) return 'nomatch'
      throw new LookupError('The WHOIS reply could not be read.')
    },
    // Read on every check, so the operator's choice applies at once.
    get paid() {
      const url = paidUrl()
      if (!url) return null
      return async (domain: string): Promise<'registered' | 'free'> => {
        const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}domain=${encodeURIComponent(domain)}`, {
          headers: process.env.NT_PAID_LOOKUP_KEY ? { authorization: 'Bearer ' + process.env.NT_PAID_LOOKUP_KEY } : {},
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new LookupError('The paid lookup service failed.', 'HTTP ' + res.status)
        const body = (await res.json()) as { registered?: boolean }
        if (typeof body.registered !== 'boolean') throw new LookupError('The paid lookup reply could not be read.')
        return body.registered ? 'registered' : 'free'
      }
    },
  }
}
