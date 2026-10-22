// One concurrent allowance attempt, run in its own thread and connection.

import { parentPort, workerData } from 'node:worker_threads'
import { openDatabase } from '../../server/db.ts'
import { AllowanceError, AllowanceStore } from '../../server/allowance.ts'

interface Job {
  file: string
  deviceId: string
  mode: 'spend' | 'reserve'
  amount: number
}

const job = workerData as Job
const db = openDatabase(job.file)

try {
  const store = new AllowanceStore(db)
  const subject = { kind: 'device' as const, id: job.deviceId }
  if (job.mode === 'spend') store.spendRound(subject, job.amount)
  else store.reserveChecks(subject, job.amount)
  parentPort?.postMessage({ ok: true })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    code: error instanceof AllowanceError ? error.code : 'unexpected',
    message: error instanceof Error ? error.message : String(error),
  })
} finally {
  db.close()
}
