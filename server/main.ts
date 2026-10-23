// Start the NameTempest API server.
//
//   node server/main.ts
//
// Environment:
//   PORT    port to listen on, default 8787
//   HOST    address to bind, default 127.0.0.1
//   NT_DB   database file, default data/nametempest.db; ":memory:" for a
//           throwaway database
//
// The Vite front end runs beside this process under `npm run dev` and
// proxies /api here. Migrations are applied before the port is opened.

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createApp } from './app.ts'
import type { Db } from './db.ts'
import { openDatabase } from './db.ts'
import { startOfferedEndingRefresh } from './offered-endings.ts'
import { VERSION } from './version.ts'

const databaseFile = process.env.NT_DB ?? resolve('data/nametempest.db')
const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a whole number from 1 to 65535; got ${process.env.PORT ?? ''}.`)
  process.exit(1)
}

if (databaseFile !== ':memory:') {
  try {
    mkdirSync(dirname(resolve(databaseFile)), { recursive: true })
  } catch (error) {
    console.error('The database folder could not be made.', error)
    process.exit(1)
  }
}

let db: Db
try {
  db = openDatabase(databaseFile)
} catch (error) {
  console.error('The database could not be opened or migrated.', error)
  process.exit(1)
}

// Refresh the offered endings from the public root zone list and RDAP
// bootstrap file now and once a day after that. A failed refresh is logged and
// the last good list stays in place, so it never blocks the API from starting.
const offeredEndingRefresh = startOfferedEndingRefresh(db)

const server = createApp({ db, version: VERSION })

server.on('error', (error) => {
  console.error('The API server could not start.', error)
  offeredEndingRefresh.stop()
  try {
    db.close()
  } catch {
    // The database may already be closed.
  }
  process.exit(1)
})

server.listen(port, host, () => {
  console.log(`NameTempest API listening on http://${host}:${port}`)
  console.log('Health: GET /api/health')
})

let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received: closing the API server.`)

  const forceClose = setTimeout(() => {
    console.error('The API server did not close in time; forcing it.')
    process.exit(1)
  }, 5000)
  forceClose.unref()

  offeredEndingRefresh.stop()

  server.close((error) => {
    clearTimeout(forceClose)
    try {
      db.close()
    } catch {
      // The database may already be closed.
    }
    if (error) {
      console.error('The API server did not close cleanly.', error)
      process.exit(1)
    }
    process.exit(0)
  })
  server.closeIdleConnections()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
