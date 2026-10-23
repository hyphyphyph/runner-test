// The typed client for the NameTempest API.
//
// The browser imports this module. Tests import it too, so the contract is
// exercised over a real socket and not only in the type checker. The base
// URL is empty in the browser: the page and the API share an origin, and
// Vite proxies /api to the server during development.

import type { ApiErrorResponse, ApiResponse, ApiRoute } from './api.ts'

/** A failed API call: a network error is left as the fetch error. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const error = (value as { error: unknown }).error
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  )
}

export class ApiClient {
  #baseUrl: string

  /**
   * @param baseUrl Origin of the API. Leave empty for same-origin use.
   */
  constructor(baseUrl = '') {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** `GET /api/health` — the server and database report. */
  health(init?: RequestInit): Promise<ApiResponse<'GET /api/health'>> {
    return this.request('GET /api/health', init)
  }

  /** `GET /api/style-lists` — the operator's style pick lists. */
  styleLists(init?: RequestInit): Promise<ApiResponse<'GET /api/style-lists'>> {
    return this.request('GET /api/style-lists', init)
  }

  /** `GET /api/offered-endings` — every ending and the facts behind its offer. */
  offeredEndings(init?: RequestInit): Promise<ApiResponse<'GET /api/offered-endings'>> {
    return this.request('GET /api/offered-endings', init)
  }

  async request<R extends ApiRoute>(route: R, init?: RequestInit): Promise<ApiResponse<R>> {
    const split = route.indexOf(' ')
    const method = route.slice(0, split)
    const path = route.slice(split + 1)
    const headers = new Headers(init?.headers)
    headers.set('accept', 'application/json')

    const response = await fetch(this.#baseUrl + path, { ...init, method, headers })
    const text = await response.text()

    let body: unknown = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new ApiError(response.status, 'invalid_response', 'The server sent a response that was not JSON.')
      }
    }

    if (!response.ok) {
      if (isApiErrorResponse(body)) throw new ApiError(response.status, body.error.code, body.error.message)
      throw new ApiError(response.status, 'http_error', `The server answered with status ${response.status}.`)
    }

    return body as ApiResponse<R>
  }
}

/** The client for the page's own origin. */
export const api = new ApiClient()
