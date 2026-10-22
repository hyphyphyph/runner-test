import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { ApiErrorResponse, HealthResponse } from '../../shared/api.ts'
import { ApiClient } from '../../shared/client.ts'
import { createApp } from '../../server/app.ts'
import { openDatabase } from '../../server/db.ts'
import type { TestServer } from '../helpers/test-server.ts'
import { startTestServer } from '../helpers/test-server.ts'

describe('GET /api/health', () => {
  let running: TestServer

  before(async () => {
    running = await startTestServer()
  })

  after(async () => {
    await running.close()
  })

  test('the typed client reads a healthy report over a real socket', async () => {
    const client = new ApiClient(running.baseUrl)
    const health: HealthResponse = await client.health()

    assert.equal(health.status, 'ok')
    assert.equal(health.service, 'nametempest')
    assert.equal(health.version, 'test')
    assert.equal(health.database.status, 'ok')
    assert.ok(health.database.migrations >= 1)
    assert.ok(health.uptimeSeconds >= 0)
    assert.match(health.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('the short /health alias answers the same report', async () => {
    const response = await fetch(`${running.baseUrl}/health`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as HealthResponse
    assert.equal(body.status, 'ok')
    assert.equal(body.database.status, 'ok')
  })

  test('the report is not cached', async () => {
    const response = await fetch(`${running.baseUrl}/api/health`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  })

  test('an unknown API route answers with a typed 404', async () => {
    const response = await fetch(`${running.baseUrl}/api/missing`)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/)

    const body = (await response.json()) as ApiErrorResponse
    assert.equal(body.error.code, 'not_found')
    assert.ok(body.error.message.length > 0)
  })

  test('a non-API path answers with a typed 404', async () => {
    const response = await fetch(`${running.baseUrl}/`)
    assert.equal(response.status, 404)
    const body = (await response.json()) as ApiErrorResponse
    assert.equal(body.error.code, 'not_found')
  })

  test('a method other than GET is refused with 405 and Allow: GET', async () => {
    const response = await fetch(`${running.baseUrl}/api/health`, { method: 'POST' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET')

    const body = (await response.json()) as ApiErrorResponse
    assert.equal(body.error.code, 'method_not_allowed')
  })
})

describe('GET /api/health with a broken database', () => {
  test('answers 503 with a degraded report', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nametempest-broken-'))
    const db = openDatabase(join(directory, 'test.db'))
    const server = createApp({ db, version: 'test' })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })

    try {
      const address = server.address()
      assert.ok(address !== null && typeof address !== 'string')
      db.close()

      const response = await fetch(`http://127.0.0.1:${address.port}/api/health`)
      assert.equal(response.status, 503)

      const body = (await response.json()) as HealthResponse
      assert.equal(body.status, 'degraded')
      assert.equal(body.database.status, 'error')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
