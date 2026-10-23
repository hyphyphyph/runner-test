import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openDatabase } from '../../server/db.ts'
import {
  OfferedEndingRefreshError,
  OfferedEndingStore,
  parseRdapBootstrap,
  parseRootZoneList,
  startOfferedEndingRefresh,
} from '../../server/offered-endings.ts'

const ROOT_ZONE = `# Version 2026102300, Last Updated Fri Oct 23 07:07:07 2026 UTC
COM
io
.Studio
com
not_a_label
`

const BOOTSTRAP = {
  version: '1.0',
  services: [
    [['com', 'io'], ['https://rdap.example.test/v1/']],
    [['studio'], ['not a url', 'http://rdap.example.test/studio/']],
    [['no-address'], []],
  ],
}

function rootText(...endings: string[]): string {
  return `# Version test\n${endings.join('\n')}\n`
}

describe('the IANA root zone list', () => {
  test('it reads bare lower-case endings and ignores the rest', () => {
    assert.deepEqual(parseRootZoneList(ROOT_ZONE), ['com', 'io', 'studio'])
  })

  test('a byte order mark, spacing and a leading dot are harmless', () => {
    assert.deepEqual(parseRootZoneList('\uFEFF  .COM  \r\n\r\n  io  \r\n'), ['com', 'io'])
  })

  test('an empty list is refused instead of emptying the offered set', () => {
    assert.throws(
      () => parseRootZoneList('# only a comment\n'),
      (error: unknown) =>
        error instanceof OfferedEndingRefreshError && error.code === 'root_zone_empty',
    )
  })
})

describe('the IANA RDAP bootstrap file', () => {
  test('it maps an ending to the first usable service address', () => {
    const routes = parseRdapBootstrap(BOOTSTRAP)
    assert.equal(routes.get('com'), 'https://rdap.example.test/v1/')
    assert.equal(routes.get('io'), 'https://rdap.example.test/v1/')
    assert.equal(routes.get('studio'), 'http://rdap.example.test/studio/')
    assert.equal(routes.has('no-address'), false)
  })

  test('a file with no usable service is refused', () => {
    for (const value of [null, [], {}, { services: [] }, { services: [[['com'], []]] }]) {
      assert.throws(
        () => parseRdapBootstrap(value),
        (error: unknown) =>
          error instanceof OfferedEndingRefreshError && error.code === 'rdap_bootstrap_invalid',
      )
    }
  })
})

describe('the offered-ending store', () => {
  test('a fresh database offers .com from the seeded row alone', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const store = new OfferedEndingStore(db, { now: () => new Date(1_000) })

    const report = store.report()
    assert.deepEqual(report.offeredEndings, ['com'])
    assert.equal(report.refreshedAt, null)
    assert.deepEqual(
      report.endings.map((ending) => [ending.ending, ending.offered, ending.requiredByProduct]),
      [['com', true, true]],
    )
    assert.equal(store.isOffered('.COM'), true)
    assert.equal(store.isOffered('io'), false)
    assert.equal(store.isOffered('not a label'), false)
  })

  test('the three tests are recorded for every ending with a reason', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const store = new OfferedEndingStore(db, {
      now: () => new Date(5_000),
      terms: (ending) =>
        ending === 'io'
          ? { allowsHostedQueries: false, reason: 'The registry terms forbid a hosted product.' }
          : true,
    })

    const result = store.applySources({
      rootZoneText: rootText('com', 'io', 'shop'),
      rdapBootstrap: BOOTSTRAP,
      fetchedAt: 4_000,
      source: 'test',
    })

    assert.deepEqual(result.offeredEndings, ['com'])
    assert.equal(result.rootZoneCount, 3)
    assert.equal(result.rdapRouteCount, 3)

    const byEnding = new Map(store.list().map((ending) => [ending.ending, ending]))
    assert.deepEqual(byEnding.get('com'), {
      ending: 'com',
      inRootZone: true,
      routeAnswersBoth: true,
      termsAllowHostedQueries: true,
      requiredByProduct: true,
      offered: true,
      reasonCode: null,
      reason: null,
      registrationQueryUrl: 'https://rdap.example.test/v1/',
      source: 'test',
      updatedAt: 4_000,
    })

    const io = byEnding.get('io')
    assert.equal(io?.inRootZone, true)
    assert.equal(io?.routeAnswersBoth, true)
    assert.equal(io?.termsAllowHostedQueries, false)
    assert.equal(io?.offered, false)
    assert.equal(io?.reasonCode, 'terms_disallow')
    assert.match(io?.reason ?? '', /forbid a hosted product/)

    const shop = byEnding.get('shop')
    assert.equal(shop?.inRootZone, true)
    assert.equal(shop?.routeAnswersBoth, false)
    assert.equal(shop?.offered, false)
    assert.equal(shop?.reasonCode, 'route_cannot_settle')
    assert.match(shop?.reason ?? '', /answers both free and taken/)

    assert.deepEqual(store.report().offeredEndings, ['com'])
    assert.equal(store.report().refreshedAt, 4_000)
  })

  test('an ending that leaves the root zone is kept with the first failed test', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const store = new OfferedEndingStore(db)

    store.applySources({
      rootZoneText: rootText('com', 'io'),
      rdapBootstrap: BOOTSTRAP,
      fetchedAt: 1_000,
    })
    assert.deepEqual(store.offered(), ['com', 'io'])

    store.applySources({
      rootZoneText: rootText('com'),
      rdapBootstrap: BOOTSTRAP,
      fetchedAt: 2_000,
    })

    const io = store.list().find((ending) => ending.ending === 'io')
    assert.equal(io?.inRootZone, false)
    assert.equal(io?.offered, false)
    assert.equal(io?.reasonCode, 'not_in_root_zone')
    assert.match(io?.reason ?? '', /missing from the root zone list/)
    assert.deepEqual(store.offered(), ['com'])
  })

  test('a terms decision is recorded and applied at once', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const store = new OfferedEndingStore(db)

    store.applySources({
      rootZoneText: rootText('com', 'io'),
      rdapBootstrap: BOOTSTRAP,
      fetchedAt: 1_000,
    })
    assert.deepEqual(store.offered(), ['com', 'io'])

    store.setTerms('io', false, {
      operator: 'operator@example.com',
      reason: 'The registry terms forbid it.',
      now: new Date(2_000),
    })

    const io = store.list().find((ending) => ending.ending === 'io')
    assert.equal(io?.termsAllowHostedQueries, false)
    assert.equal(io?.offered, false)
    assert.equal(io?.reasonCode, 'terms_disallow')
    assert.equal(io?.reason, 'The registry terms forbid it.')
    assert.deepEqual(store.offered(), ['com'])

    const recorded = db
      .prepare('select allows_hosted_queries, reason, decided_by from registry_terms where ending = ?')
      .get('io') as { allows_hosted_queries: number; reason: string; decided_by: string }
    assert.equal(recorded.allows_hosted_queries, 0)
    assert.equal(recorded.reason, 'The registry terms forbid it.')
    assert.equal(recorded.decided_by, 'operator@example.com')
  })

  test('a refresh reads both public files and records the time', async (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const requested: string[] = []
    const fetch = (async (url: string | URL | Request) => {
      const address = String(url)
      requested.push(address)
      if (address.includes('tlds-alpha-by-domain')) return new Response(rootText('com', 'io'))
      return new Response(JSON.stringify(BOOTSTRAP))
    }) as typeof globalThis.fetch

    const store = new OfferedEndingStore(db, { fetch, now: () => new Date(9_000) })
    const result = await store.refresh()

    assert.equal(requested.length, 2)
    assert.ok(requested.some((address) => address.includes('tlds-alpha-by-domain')))
    assert.ok(requested.some((address) => address.includes('dns.json')))
    assert.equal(result.fetchedAt, 9_000)
    assert.deepEqual(result.offeredEndings, ['com', 'io'])
    assert.deepEqual(store.refreshState(), { attemptedAt: 9_000, refreshedAt: 9_000, error: null })
  })

  test('a failed refresh leaves the last good list in place', async (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    let offline = false
    const fetch = (async (url: string | URL | Request) => {
      if (offline) throw new Error('offline')
      const address = String(url)
      if (address.includes('tlds-alpha-by-domain')) return new Response(rootText('com', 'io'))
      return new Response(JSON.stringify(BOOTSTRAP))
    }) as typeof globalThis.fetch

    const store = new OfferedEndingStore(db, {
      fetch,
      now: () => new Date(offline ? 20_000 : 10_000),
    })
    await store.refresh()
    assert.deepEqual(store.offered(), ['com', 'io'])

    offline = true
    await assert.rejects(
      store.refresh(),
      (error: unknown) =>
        error instanceof OfferedEndingRefreshError && error.code === 'source_unreachable',
    )

    assert.deepEqual(store.offered(), ['com', 'io'])
    assert.equal(store.refreshState().refreshedAt, 10_000)
    assert.equal(store.refreshState().attemptedAt, 20_000)
    assert.match(store.refreshState().error ?? '', /could not be reached/)
  })

  test('a malformed bootstrap file changes no stored fact', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const store = new OfferedEndingStore(db)

    store.applySources({
      rootZoneText: rootText('com', 'io'),
      rdapBootstrap: BOOTSTRAP,
      fetchedAt: 1_000,
    })
    const before = store.list()

    assert.throws(
      () =>
        store.applySources({
          rootZoneText: rootText('com', 'io'),
          rdapBootstrap: { services: [] },
          fetchedAt: 2_000,
        }),
      (error: unknown) =>
        error instanceof OfferedEndingRefreshError && error.code === 'rdap_bootstrap_invalid',
    )
    assert.deepEqual(store.list(), before)
    assert.equal(store.report().refreshedAt, 1_000)
  })

  test('the daily job shares one refresh and can be stopped', async (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())

    const fetch = (async (url: string | URL | Request) => {
      const address = String(url)
      if (address.includes('tlds-alpha-by-domain')) return new Response(rootText('com', 'io'))
      return new Response(JSON.stringify(BOOTSTRAP))
    }) as typeof globalThis.fetch

    const job = startOfferedEndingRefresh(db, {
      fetch,
      intervalMs: 60_000,
      runImmediately: false,
      now: () => new Date(30_000),
    })
    t.after(() => job.stop())

    const [first, second] = await Promise.all([job.refresh(), job.refresh()])
    assert.equal(first.fetchedAt, 30_000)
    assert.equal(second.fetchedAt, 30_000)
    assert.deepEqual(first.offeredEndings, ['com', 'io'])
  })
})
