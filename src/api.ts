// Talking to the server. Every failure becomes a plain message; a counted
// action that is refused for lack of allowance becomes a gate.

import type { Gate } from '../shared/types.ts'

export class ApiError extends Error {
  status: number
  retry: boolean
  gate: Gate | null
  body: Record<string, unknown>
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.retry = body.retry !== false
    this.gate = body.gate === true ? (body as unknown as Gate) : null
    this.body = body
  }
}

type Listener = (online: boolean) => void
const listeners = new Set<Listener>()
let online = navigator.onLine

export function onConnection(fn: Listener): void {
  listeners.add(fn)
}

export function isOnline(): boolean {
  return online
}

function setOnline(v: boolean): void {
  if (online === v) return
  online = v
  for (const fn of listeners) fn(v)
}

window.addEventListener('online', () => setOnline(true))
window.addEventListener('offline', () => setOnline(false))

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    })
  } catch {
    setOnline(false)
    throw new ApiError(0, 'The connection to NameTempest was lost. Nothing was saved. Try again when you are back online.', { retry: true })
  }
  setOnline(true)
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const message = data?.error ?? 'Something went wrong on our side. Nothing was charged. Try again.'
    throw new ApiError(res.status, message, data ?? {})
  }
  return data as T
}
