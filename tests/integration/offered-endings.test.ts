import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { ApiErrorResponse } from '../../shared/api.ts'
import { ApiClient } from '../../shared/client.ts'
import type { OfferedEndingsReport } from '../../shared/endings.ts'
import { OfferedEndingStore } from '../../server/offered-endings.ts'
import type { TestServer } from '../helpers/test-server.ts'
import { startTestServer } from '../helpers/test-server.ts'

const ROOT_ZONE = '# Version test\ncom\nio\nshop\n'

const BOOTSTRAP = {
  services: [[['com', 'io'], ['https://rdap.example.test/v1/']]],
}

describe('GET /api/offered-endings', () => {
  let running: TestServer

  before(async () => {
    running = await startTestServer()
  })

  after(async () => {
    await running.close()
  })

  test('the typed client reads the one offered-ending report', async () => {
    const client = new ApiClient(running.baseUrl)
    const report: OfferedEndingsReport = await client.offeredEndings()

    assert.deepEqual(report.offeredEndings, ['com'])
    assert.equal(report.refreshedAt, null)
    assert.deepEqual(report.endings.map((ending) => ending.ending), ['com'])
  })

  test('a refresh is visible to the next read, including each refusal reason', async () => {
    const store = new OfferedEndingStore(running.db)
    store.applySources({
      rootZoneText: ROOT_ZONE,
      rdapBootstrap: BOOTSTRAP,
      fetchedAt: 1_000,
      source: 'test',
    })

    const response = await fetch(`${running.baseUrl}/api/offered-endings`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/)

    const report = (await response.json()) as OfferedEndingsReport
    assert.deepEqual(report.offeredEndings, ['com', 'io'])
    assert.equal(report.refreshedAt, 1_000)

    const shop = report.endings.find((ending) => ending.ending === 'shop')
    assert.equal(shop?.offered, false)
    assert.equal(shop?.reasonCode, 'route_cannot_settle')
    assert.match(shop?.reason ?? '', /answers both free and taken/)
  })

  test('a method other than GET is refused with Allow: GET', async () => {
    const response = await fetch(`${running.baseUrl}/api/offered-endings`, { method: 'POST' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET')

    const body = (await response.json()) as ApiErrorResponse
    assert.equal(body.error.code, 'method_not_allowed')
  })
})
