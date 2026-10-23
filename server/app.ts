// The HTTP application. It answers JSON under /api and nothing else.
// The Vite front end is served by Vite in development and by the static
// host in production; this process owns the API.

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Db } from './db.ts'
import { countMigrations } from './db.ts'
import { OfferedEndingStore } from './offered-endings.ts'
import { StyleListStore } from './style-lists.ts'
import type { ApiErrorResponse, HealthResponse } from '../shared/api.ts'

export interface AppOptions {
  db: Db
  /** Version reported by the health endpoint. */
  version?: string
  /** Process start time in milliseconds, used for uptime. */
  startedAt?: number
  /** Injectable clock, so a test can fix the time. */
  now?: () => Date
}

const SERVICE = 'nametempest'
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiErrorResponse = { error: { code, message } }
  sendJson(res, status, body)
}

function healthBody(options: AppOptions, startedAt: number): { body: HealthResponse; status: number } {
  const now = options.now?.() ?? new Date()
  const uptimeSeconds = Math.max(0, Math.floor((now.getTime() - startedAt) / 1000))

  let database: HealthResponse['database']
  try {
    options.db.prepare('select 1 as ok').get()
    database = { status: 'ok', migrations: countMigrations(options.db) }
  } catch {
    database = { status: 'error', migrations: 0 }
  }

  const status: HealthResponse['status'] = database.status === 'ok' ? 'ok' : 'degraded'
  return {
    body: {
      status,
      service: SERVICE,
      version: options.version ?? '0.0.0',
      uptimeSeconds,
      time: now.toISOString(),
      database,
    },
    status: database.status === 'ok' ? 200 : 503,
  }
}

export function createApp(options: AppOptions): Server {
  const startedAt = options.startedAt ?? Date.now()

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://internal').pathname
    } catch {
      sendError(res, 400, 'bad_request', 'The request address could not be read.')
      return
    }

    if (pathname === '/api/health' || pathname === '/health') {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendError(res, 405, 'method_not_allowed', 'This route accepts GET only.')
        return
      }

      const report = healthBody(options, startedAt)
      sendJson(res, report.status, report.body)
      return
    }

    if (pathname === '/api/style-lists') {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendError(res, 405, 'method_not_allowed', 'This route accepts GET only.')
        return
      }

      try {
        const store = new StyleListStore(options.db, { now: options.now })
        sendJson(res, 200, store.lists())
      } catch {
        sendError(res, 500, 'style_lists_unavailable', 'The style choices could not be read right now.')
      }
      return
    }

    if (pathname === '/api/offered-endings') {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendError(res, 405, 'method_not_allowed', 'This route accepts GET only.')
        return
      }

      try {
        const store = new OfferedEndingStore(options.db, { now: options.now })
        sendJson(res, 200, store.report())
      } catch {
        sendError(res, 500, 'offered_endings_unavailable', 'The offered endings could not be read right now.')
      }
      return
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      sendError(res, 404, 'not_found', 'No API route matches that path.')
      return
    }

    sendError(res, 404, 'not_found', 'The API serves only /api routes.')
  }

  return createServer(handler)
}
