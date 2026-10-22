// Start a real API server on a throwaway database for an integration test.

import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../server/app.ts'
import type { Db } from '../../server/db.ts'
import { openDatabase } from '../../server/db.ts'

export interface TestServer {
  baseUrl: string
  db: Db
  server: Server
  close(): Promise<void>
}

export async function startTestServer(): Promise<TestServer> {
  const directory = mkdtempSync(join(tmpdir(), 'nametempest-test-'))
  const db = openDatabase(join(directory, 'test.db'))
  const server = createApp({ db, version: 'test' })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (error) {
    db.close()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }

  const address = server.address()
  if (address === null || typeof address === 'string') {
    db.close()
    rmSync(directory, { recursive: true, force: true })
    throw new Error('The test server did not report a network port.')
  }

  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    server,
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      db.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
