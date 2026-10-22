import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { AllowanceStore } from '../../server/allowance.ts'
import { openDatabase } from '../../server/db.ts'
import type { Db } from '../../server/db.ts'

interface WorkerResult {
  ok: boolean
  code?: string
  message?: string
}

function attempt(file: string, deviceId: string, mode: 'spend' | 'reserve', amount: number): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../helpers/allowance-worker.ts', import.meta.url), {
      workerData: { file, deviceId, mode, amount },
    })
    worker.once('message', (message: WorkerResult) => resolve(message))
    worker.once('error', reject)
  })
}

describe('allowance concurrency across connections', () => {
  let directory: string
  let file: string
  let db: Db

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'nametempest-allowance-'))
    file = join(directory, 'shared.db')
    db = openDatabase(file)
    db.prepare(
      "insert into devices (id, created_at, allowance_anchor_day) values ('race-spend', ?, 23)",
    ).run(Date.parse('2026-10-23T12:00:00.000Z'))
    db.prepare(
      "insert into devices (id, created_at, allowance_anchor_day) values ('race-reserve', ?, 23)",
    ).run(Date.parse('2026-10-23T12:00:00.000Z'))
  })

  after(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  test('only five of eight simultaneous rounds take the five-round allowance', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => attempt(file, 'race-spend', 'spend', 1)),
    )

    assert.equal(results.filter((result) => result.ok).length, 5)
    assert.equal(
      results.filter((result) => !result.ok && result.code === 'allowance_exhausted').length,
      3,
    )

    const store = new AllowanceStore(db)
    assert.equal(store.allowance({ kind: 'device', id: 'race-spend' }).used.rounds, 5)
    assert.equal(store.allowance({ kind: 'device', id: 'race-spend' }).remaining.rounds, 0)
  })

  test('only three of eight simultaneous ten-check reserves take the 36 checks', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => attempt(file, 'race-reserve', 'reserve', 10)),
    )

    assert.equal(results.filter((result) => result.ok).length, 3)
    assert.equal(
      results.filter((result) => !result.ok && result.code === 'allowance_exhausted').length,
      5,
    )

    const store = new AllowanceStore(db)
    const snapshot = store.allowance({ kind: 'device', id: 'race-reserve' })
    assert.equal(snapshot.used.checks, 30)
    assert.equal(snapshot.remaining.checks, 6)
    assert.equal(store.heldReservations({ kind: 'device', id: 'race-reserve' }).length, 3)
  })
})
