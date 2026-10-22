import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { ApiErrorResponse } from '../../shared/api.ts'
import { ApiClient } from '../../shared/client.ts'
import type { StyleLists } from '../../shared/style.ts'
import { SHIPPED_STYLE_LISTS } from '../../shared/style.ts'
import { StyleListStore } from '../../server/style-lists.ts'
import type { TestServer } from '../helpers/test-server.ts'
import { startTestServer } from '../helpers/test-server.ts'

describe('GET /api/style-lists', () => {
  let running: TestServer

  before(async () => {
    running = await startTestServer()
  })

  after(async () => {
    await running.close()
  })

  test('the typed client reads the shipped lists over a real socket', async () => {
    const client = new ApiClient(running.baseUrl)
    const lists: StyleLists = await client.styleLists()

    assert.deepEqual(lists.namingStyles, SHIPPED_STYLE_LISTS.namingStyles)
    assert.deepEqual(lists.tones, SHIPPED_STYLE_LISTS.tones)
    assert.deepEqual(lists.endings, SHIPPED_STYLE_LISTS.endings)
    assert.deepEqual(lists.offeredEndings, SHIPPED_STYLE_LISTS.offeredEndings)
  })

  test('an operator change is visible to the next read', async () => {
    const store = new StyleListStore(running.db)
    store.addOption('tone', 'plainspoken', 'Plain spoken', 'operator@example.com')
    assert.equal(store.removeEnding('studio', 'operator@example.com'), true)

    const response = await fetch(`${running.baseUrl}/api/style-lists`)
    assert.equal(response.status, 200)
    const lists = (await response.json()) as StyleLists
    assert.ok(lists.tones.some((tone) => tone.id === 'plainspoken' && tone.label === 'Plain spoken'))
    assert.ok(!lists.endings.includes('studio'))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
  })

  test('a method other than GET is refused with Allow: GET', async () => {
    const response = await fetch(`${running.baseUrl}/api/style-lists`, { method: 'POST' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET')

    const body = (await response.json()) as ApiErrorResponse
    assert.equal(body.error.code, 'method_not_allowed')
  })
})
