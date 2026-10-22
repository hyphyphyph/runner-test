// Small HTTP helpers: cookies, JSON bodies, plain error replies.

import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = { error: message, ...extra }
  }
}

export function fail(status: number, message: string, extra: Record<string, unknown> = {}): never {
  throw new HttpError(status, message, extra)
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function setCookie(res: ServerResponse, name: string, value: string, maxAgeSeconds: number, secure: boolean): void {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ]
  const prev = res.getHeader('set-cookie')
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : []
  res.setHeader('set-cookie', [...list, attrs.join('; ')])
}

export async function rawBody(req: IncomingMessage, limit = 200_000): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) fail(413, 'That request is too large.')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await rawBody(req)
  if (buf.length === 0) return {}
  try {
    const v = JSON.parse(buf.toString('utf8'))
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(400, 'That request could not be read.')
    return v
  } catch (e) {
    if (e instanceof HttpError) throw e
    fail(400, 'That request could not be read.')
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(data)
}

export function sendFile(res: ServerResponse, type: string, filename: string, body: string): void {
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

// Typed reads from a JSON body.
export function str(body: Record<string, unknown>, key: string, max = 5000, required = false): string {
  const v = body[key]
  if (v === undefined || v === null) {
    if (required) fail(400, `Please fill in ${key}.`)
    return ''
  }
  if (typeof v !== 'string') fail(400, `${key} must be text.`)
  if (v.length > max) fail(400, `${key} is too long; keep it under ${max} characters.`)
  if (required && !v.trim()) fail(400, `Please fill in ${key}.`)
  return v
}

export function strList(body: Record<string, unknown>, key: string, maxItems = 200): string[] {
  const v = body[key]
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== 'string')) fail(400, `${key} must be a list.`)
  return v as string[]
}

// A simple per-key rate limiter for sign-in and email sends.
export class RateLimit {
  private hits = new Map<string, number[]>()
  private max: number
  private windowMs: number
  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
  }
  take(key: string): boolean {
    const now = Date.now()
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    return true
  }
}
