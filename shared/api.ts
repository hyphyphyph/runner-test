// The API contract shared by the server and the browser.
//
// This file holds types only. It is imported by the server, by the typed
// client in ./client.ts, and by the browser through that client, so both
// ends of every call are checked against the same shape.

import type { StyleLists } from './style.ts'

/** The answer to a database check inside the health report. */
export interface HealthDatabase {
  status: 'ok' | 'error'
  /** How many migrations have been applied to the open database. */
  migrations: number
}

/** The answer to `GET /api/health`. */
export interface HealthResponse {
  status: 'ok' | 'degraded'
  service: 'nametempest'
  version: string
  uptimeSeconds: number
  /** ISO 8601 time the report was produced. */
  time: string
  database: HealthDatabase
}

/** The JSON body of every failed API call. */
export interface ApiErrorResponse {
  error: {
    code: string
    message: string
  }
}

/**
 * Every route the typed client may call, keyed by method and path.
 *
 * Add a route here before calling it, so the server and the browser agree
 * on the response shape.
 */
export interface ApiContract {
  'GET /api/health': { response: HealthResponse }
  /**
   * The pick lists behind the style form. The operator edits them in the
   * admin interface; the browser reads them here and falls back to the
   * shipped lists when the server cannot answer.
   */
  'GET /api/style-lists': { response: StyleLists }
}

export type ApiRoute = keyof ApiContract

export type ApiResponse<R extends ApiRoute> = ApiContract[R]['response']
