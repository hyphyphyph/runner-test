// Email (Email). Only the messages the product needs in order to work, each
// naming the site and the reason in its first line, and none holding a
// description, a generated name or a domain result. Sends are queued and
// retried.

import type { Db } from './db.ts'
import { all, id, one, run } from './db.ts'

export type EmailKind =
  | 'magic'
  | 'invite'
  | 'membership'
  | 'receipt'
  | 'payment-failed'
  | 'admin-notice'
  | 'deletion-soon'
  | 'deleted'
  | 'operator-alert'

// The emails a person may turn off. The magic link and the receipt for a
// payment they made are always sent.
export const OPTIONAL_EMAILS: Record<string, string> = {
  membership: 'When someone is added to or removed from your organization',
  'payment-failed': 'When a payment does not go through',
  'admin-notice': 'When an operator change touches what you paid for',
  'deletion-soon': 'Before your account is deleted, and once it has been',
}

export interface Transport {
  send(to: string, subject: string, body: string): Promise<void>
}

export class ConsoleTransport implements Transport {
  async send(to: string, subject: string, body: string): Promise<void> {
    if (process.env.NODE_ENV !== 'test') console.log(`[email] to=${to} subject=${subject}\n${body}\n`)
  }
}

// A Resend-compatible HTTP provider. The provider is an open question, so
// this is one adapter behind the Transport interface.
export class HttpTransport implements Transport {
  private key: string
  private from: string
  constructor(key: string, from: string) {
    this.key = key
    this.from = from
  }
  async send(to: string, subject: string, body: string): Promise<void> {
    const res = await fetch(process.env.NT_EMAIL_URL ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.key, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [to], subject, text: body }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error('email provider HTTP ' + res.status)
  }
}

const REASONS: Record<EmailKind, string> = {
  magic: 'you asked for a sign-in link',
  invite: 'a studio invited you to join it',
  membership: 'your organization changed',
  receipt: 'you made a payment',
  'payment-failed': 'a payment did not go through',
  'admin-notice': 'an operator changed something you paid for',
  'deletion-soon': 'your account is about to be deleted',
  deleted: 'your account was deleted',
  'operator-alert': 'a part of the product is failing',
}

export class Mailer {
  private db: Db
  private transport: Transport
  private timer: NodeJS.Timeout | null = null
  private sending = false

  constructor(db: Db, transport: Transport) {
    this.db = db
    this.transport = transport
  }

  // Queue a message. Returns false when the person turned this kind off.
  queue(to: string, kind: EmailKind, subject: string, lines: string[]): boolean {
    const optionalKey = kind === 'deleted' ? 'deletion-soon' : kind
    if (optionalKey in OPTIONAL_EMAILS) {
      const acc = one<{ email_prefs: string }>(this.db, 'select email_prefs from accounts where email = ?', to)
      if (acc && JSON.parse(acc.email_prefs)[optionalKey] === false) return false
    }
    const body = [`NameTempest (nametempest.com) is writing because ${REASONS[kind]}.`, '', ...lines].join('\n')
    const now = Date.now()
    run(
      this.db,
      'insert into outbox (id, to_addr, kind, subject, body, created_at, next_at) values (?, ?, ?, ?, ?, ?, ?)',
      id('m_'),
      to,
      kind,
      `NameTempest: ${subject}`,
      body,
      now,
      now,
    )
    queueMicrotask(() => void this.flush())
    return true
  }

  async flush(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      const due = all<{ id: string; to_addr: string; subject: string; body: string; attempts: number }>(
        this.db,
        'select * from outbox where sent_at is null and attempts < 8 and next_at <= ? order by created_at limit 20',
        Date.now(),
      )
      for (const m of due) {
        try {
          await this.transport.send(m.to_addr, m.subject, m.body)
          run(this.db, 'update outbox set sent_at = ?, attempts = attempts + 1 where id = ?', Date.now(), m.id)
        } catch (e) {
          // Retry with a growing wait.
          const wait = Math.min(60 * 60 * 1000, 15000 * 2 ** m.attempts)
          run(
            this.db,
            'update outbox set attempts = attempts + 1, next_at = ?, last_error = ? where id = ?',
            Date.now() + wait,
            String(e).slice(0, 300),
            m.id,
          )
        }
      }
    } finally {
      this.sending = false
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), 5000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  recent(to: string) {
    return all<{ kind: string; subject: string; body: string; created_at: number }>(
      this.db,
      'select kind, subject, body, created_at from outbox where to_addr = ? order by created_at desc limit 20',
      to,
    )
  }
}
