// Transactional email (Email).
//
// Only four kinds may leave the product: a magic link (which a password reset
// uses too), an invitation, a receipt and an admin notice. The kind is checked
// before anything is composed, so a message that fits none of them is refused
// in code rather than quietly delivered.
//
// A composed message carries no project material. The request types below
// name every field a kind accepts, and the composer refuses any other field,
// so a company description, a generated name or a domain result cannot reach
// a mail provider through this module. Each message's first line names the
// site and the reason it was sent.
//
// The provider is a seam because the provider and the sending address are
// open questions. A failed send is tried again by the service itself; a
// message that still cannot be sent raises EmailError and is never reported as
// sent. A magic link send never touches the allowance.
//
// A recipient may turn off invitations, admin notices and receipts that are
// not for a payment they made. A magic link and a receipt for the recipient's
// own payment are always sent, and the preference store refuses to turn off a
// magic link.

import type { Db } from './db.ts'

/** The four kinds Email.sends names, and nothing else. */
export const EMAIL_KINDS = ['magic_link', 'invitation', 'receipt', 'admin_notice'] as const

export type EmailKind = (typeof EMAIL_KINDS)[number]

/** The site every message names in its first line. */
export const SITE_NAME = 'NameTempest'
export const SITE_DOMAIN = 'nametempest.com'

export type MagicLinkPurpose = 'sign_in' | 'password_reset'
export type InvitationEvent = 'invited' | 'member_added' | 'member_removed'
export type ReceiptEvent = 'paid' | 'payment_failed'
export type ReceiptItem = 'subscription' | 'credit_pack'
export type AdminNoticeEvent =
  | 'plan_changed'
  | 'credits_changed'
  | 'seats_changed'
  | 'account_deletion_scheduled'
  | 'account_deleted'

/**
 * A sign-in or password-reset message. The caller issues the single-use link;
 * this service only explains why it is being sent and delivers it.
 */
export interface MagicLinkEmail {
  kind: 'magic_link'
  to: string
  purpose: MagicLinkPurpose
  link: string
  /** When the link stops working, in milliseconds since the Unix epoch. */
  expiresAt: number
}

/** An invitation, or the notice that a member was added to or removed from an organization. */
export interface InvitationEmail {
  kind: 'invitation'
  to: string
  event: InvitationEvent
  /** The organization's label, so the recipient knows which studio invited them. */
  organization: string
  link?: string
}

/** A receipt, or the payment-failure notice about the same payment. */
export interface ReceiptEmail {
  kind: 'receipt'
  to: string
  event: ReceiptEvent
  item: ReceiptItem
  amountCents: number
  /** A three-letter ISO 4217 code, such as USD. */
  currency: string
  /** The address that made the payment, used to decide whether the receipt can be turned off. */
  paidBy: string
}

/** A notice that a change touched what a person paid for, or that an account is going away. */
export interface AdminNoticeEmail {
  kind: 'admin_notice'
  to: string
  event: AdminNoticeEvent
  organization?: string
  /** The time the change takes effect, in milliseconds since the Unix epoch. */
  effectiveAt?: number
}

export type TransactionalEmail = MagicLinkEmail | InvitationEmail | ReceiptEmail | AdminNoticeEmail

/** A message the provider receives. It exists only after composeEmail accepted a request. */
export interface OutgoingEmail {
  kind: EmailKind
  to: string
  subject: string
  /** The first line of the body, which names the site and the reason. */
  firstLine: string
  text: string
}

/** What a provider may answer when it accepted a message. */
export interface EmailProviderResult {
  /** The provider's own id for the message, kept only for support. */
  messageId?: string
}

/**
 * The transactional email provider seam.
 *
 * Only a composed message can pass through `send`: it checks the kind, the
 * recipient and the first line before any implementation is asked to deliver.
 * An implementation throws when a message was not accepted; the service
 * retries a thrown failure and never treats a rejected message as sent.
 */
export abstract class EmailProvider {
  async send(message: OutgoingEmail): Promise<EmailProviderResult | void> {
    assertOutgoingEmail(message)
    return this.deliver(message)
  }

  /** Deliver one checked message, or throw when the provider did not take it. */
  protected abstract deliver(message: OutgoingEmail): EmailProviderResult | void | Promise<EmailProviderResult | void>
}

/** Provider used by unit tests and by a development run that must not send. */
export class MemoryEmailProvider extends EmailProvider {
  readonly sent: OutgoingEmail[] = []
  #nextMessageId = 1

  protected deliver(message: OutgoingEmail): EmailProviderResult {
    this.sent.push({ ...message })
    return { messageId: `memory-${this.#nextMessageId++}` }
  }
}

export type EmailErrorCode =
  | 'unsupported_kind'
  | 'invalid_recipient'
  | 'invalid_details'
  | 'always_sent'
  | 'provider_required'
  | 'delivery_failed'

/** A refused or failed email operation, with a message that is safe to show. */
export class EmailError extends Error {
  readonly code: EmailErrorCode
  readonly kind: string | null

  constructor(code: EmailErrorCode, message: string, kind: string | null = null, cause?: unknown) {
    super(message)
    this.name = 'EmailError'
    this.code = code
    this.kind = kind
    if (cause !== undefined) this.cause = cause
  }
}

/** The fields one kind accepts. Any other field is refused before composing. */
const ALLOWED_FIELDS: Readonly<Record<EmailKind, readonly string[]>> = {
  magic_link: ['kind', 'to', 'purpose', 'link', 'expiresAt'],
  invitation: ['kind', 'to', 'event', 'organization', 'link'],
  receipt: ['kind', 'to', 'event', 'item', 'amountCents', 'currency', 'paidBy'],
  admin_notice: ['kind', 'to', 'event', 'organization', 'effectiveAt'],
}

/**
 * Fields that would carry a person's work. They are refused by name, so a
 * future caller gets a clear reason instead of a message that quietly holds a
 * description, a generated name or a domain result.
 */
const WORK_FIELDS = new Set([
  'description',
  'companyDescription',
  'candidate',
  'candidateName',
  'generatedName',
  'name',
  'names',
  'domain',
  'domains',
  'domainResult',
  'domainResults',
  'project',
  'projects',
  'note',
  'notes',
])

/** True when a value is one of the four kinds the product may send. */
export function isEmailKind(value: unknown): value is EmailKind {
  return typeof value === 'string' && (EMAIL_KINDS as readonly string[]).includes(value)
}

/** Check a kind and return it, or refuse anything outside the four. */
export function assertEmailKind(value: unknown): EmailKind {
  if (isEmailKind(value)) return value
  const shown = typeof value === 'string' ? JSON.stringify(value) : 'that value'
  throw new EmailError(
    'unsupported_kind',
    `NameTempest sends only a magic link, an invitation, a receipt and an admin notice; ${shown} is not one of them.`,
  )
}

/** Trim and lower-case an address so two sends reach the same preference row. */
export function normalizeEmail(value: unknown, kind: EmailKind | null = null): string {
  if (typeof value !== 'string') {
    throw new EmailError('invalid_recipient', 'An email needs a recipient address.', kind)
  }
  const clean = value.trim().toLowerCase()
  if (clean.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new EmailError('invalid_recipient', 'That email address cannot receive mail.', kind)
  }
  return clean
}

/** The fields a composed message may carry. */
const OUTGOING_FIELDS = new Set(['kind', 'to', 'subject', 'firstLine', 'text'])

/**
 * Check a message at the provider boundary.
 *
 * The service composes through `composeEmail`, so this is a second line of
 * defence: a provider can never be asked to send an unknown kind, an address
 * that cannot receive mail, or a body whose first line does not name the site
 * and the reason.
 */
export function assertOutgoingEmail(message: OutgoingEmail): void {
  if (typeof message !== 'object' || message === null) {
    throw new EmailError('invalid_details', 'An email message needs a kind, a recipient and a body.')
  }

  const raw = message as unknown as Record<string, unknown>
  const kind = assertEmailKind(raw.kind)
  normalizeEmail(raw.to, kind)

  for (const field of Object.keys(raw)) {
    if (WORK_FIELDS.has(field)) {
      throw new EmailError(
        'invalid_details',
        'An email never carries a company description, a generated name or a domain result.',
        kind,
      )
    }
    if (!OUTGOING_FIELDS.has(field)) {
      throw new EmailError('invalid_details', 'An email carries only its kind, recipient, subject and body.', kind)
    }
  }

  if (typeof raw.subject !== 'string' || raw.subject.trim().length === 0) {
    throw new EmailError('invalid_details', 'An email needs a subject.', kind)
  }
  if (
    typeof raw.firstLine !== 'string' ||
    !raw.firstLine.startsWith(FIRST_LINE_SITE) ||
    raw.firstLine.length <= FIRST_LINE_SITE.length
  ) {
    throw new EmailError('invalid_details', 'An email must name the site and the reason in its first line.', kind)
  }
  if (typeof raw.text !== 'string' || raw.text.split('\n')[0] !== raw.firstLine) {
    throw new EmailError('invalid_details', 'An email must name the site and the reason in its first line.', kind)
  }
}

/**
 * Compose one message. The first line names the site and the reason it was
 * sent; every later line comes from the fields the kind allows.
 */
export function composeEmail(request: TransactionalEmail): OutgoingEmail {
  if (typeof request !== 'object' || request === null) {
    throw new EmailError('invalid_details', 'An email needs a kind and its details.')
  }

  const raw = request as unknown as Record<string, unknown>
  const kind = assertEmailKind(raw.kind)
  refuseUnknownFields(raw, kind)
  const to = normalizeEmail(raw.to, kind)

  switch (kind) {
    case 'magic_link':
      return composeMagicLink(request as MagicLinkEmail, to)
    case 'invitation':
      return composeInvitation(request as InvitationEmail, to)
    case 'receipt':
      return composeReceipt(request as ReceiptEmail, to)
    case 'admin_notice':
      return composeAdminNotice(request as AdminNoticeEmail, to)
    default:
      return assertNever(kind)
  }
}

/** The address that paid, when this is a receipt. */
export function receiptPayer(request: TransactionalEmail): string | null {
  return request.kind === 'receipt' ? normalizeEmail(request.paidBy, 'receipt') : null
}

/**
 * True when a kind cannot be turned off for this recipient. A magic link is
 * always sent, and a receipt for a payment the recipient made is always sent.
 */
export function isAlwaysSent(kind: EmailKind, recipient: string, payer: string | null = null): boolean {
  if (kind === 'magic_link') return true
  if (kind !== 'receipt' || payer === null) return false
  return normalizeEmail(recipient, kind) === normalizeEmail(payer, kind)
}

/** A whole email send, after any retries. */
export interface EmailSendResult {
  status: 'sent' | 'suppressed'
  kind: EmailKind
  to: string
  /** How many provider attempts were made. Zero when a preference suppressed it. */
  attempts: number
  providerMessageId: string | null
}

/** How the service retries a provider that failed. */
export interface EmailRetryOptions {
  /** Total attempts, including the first. Defaults to three. */
  attempts?: number
  /** Wait before each retry, in milliseconds. The last value is reused. */
  delaysMs?: readonly number[]
  /** Injectable wait, so a test does not sleep. */
  sleep?: (milliseconds: number) => Promise<void>
}

const DEFAULT_ATTEMPTS = 3
const DEFAULT_DELAYS_MS = [1_000, 5_000]

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export interface TransactionalEmailServiceOptions {
  provider: EmailProvider
  preferences: EmailPreferenceStore
  retry?: EmailRetryOptions
}

/**
 * The service that turns a checked request into a delivered message.
 *
 * It composes first, so bad details are refused even when the recipient has
 * opted out. It checks the opt-out only for kinds a person may turn off, then
 * asks the provider, retrying a failed send under the retry policy.
 */
export class TransactionalEmailService {
  readonly #provider: EmailProvider
  readonly #preferences: EmailPreferenceStore
  readonly #attempts: number
  readonly #delaysMs: readonly number[]
  readonly #sleep: (milliseconds: number) => Promise<void>

  constructor(options: TransactionalEmailServiceOptions) {
    if (typeof options.provider !== 'object' || options.provider === null || typeof options.provider.send !== 'function') {
      throw new EmailError('provider_required', 'A transactional email provider is needed before mail can be sent.')
    }

    const attempts = options.retry?.attempts ?? DEFAULT_ATTEMPTS
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError('The email retry count must be a positive whole number.')
    }

    const delays = options.retry?.delaysMs ?? DEFAULT_DELAYS_MS
    for (const delay of delays) {
      if (!Number.isFinite(delay) || delay < 0) {
        throw new RangeError('An email retry delay must be zero or a positive number of milliseconds.')
      }
    }

    this.#provider = options.provider
    this.#preferences = options.preferences
    this.#attempts = attempts
    this.#delaysMs = [...delays]
    this.#sleep = options.retry?.sleep ?? defaultSleep
  }

  /**
   * Send one of the four kinds.
   *
   * Returns `suppressed` without asking the provider when the recipient has
   * turned the kind off. Throws EmailError('delivery_failed') after the last
   * retry fails, so the caller never tells a person an email was sent when it
   * was not.
   */
  async send(request: TransactionalEmail): Promise<EmailSendResult> {
    const message = composeEmail(request)
    const payer = receiptPayer(request)

    if (!isAlwaysSent(message.kind, message.to, payer) && this.#preferences.isOptedOut(message.to, message.kind)) {
      return {
        status: 'suppressed',
        kind: message.kind,
        to: message.to,
        attempts: 0,
        providerMessageId: null,
      }
    }

    const delivery = await this.#deliver(message)
    return {
      status: 'sent',
      kind: message.kind,
      to: message.to,
      attempts: delivery.attempts,
      providerMessageId: delivery.providerMessageId,
    }
  }

  async #deliver(message: OutgoingEmail): Promise<{ attempts: number; providerMessageId: string | null }> {
    let lastError: unknown = null

    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      try {
        const result = await this.#provider.send(message)
        return { attempts: attempt, providerMessageId: result?.messageId ?? null }
      } catch (error) {
        lastError = error
        if (attempt < this.#attempts) await this.#sleep(this.#delayAfter(attempt))
      }
    }

    throw new EmailError(
      'delivery_failed',
      `The ${plainKind(message.kind)} could not be sent after ${this.#attempts} ${this.#attempts === 1 ? 'try' : 'tries'}.`,
      message.kind,
      lastError,
    )
  }

  #delayAfter(failedAttempt: number): number {
    if (this.#delaysMs.length === 0) return 0
    return this.#delaysMs[Math.min(failedAttempt - 1, this.#delaysMs.length - 1)]
  }
}

/**
 * The per-address opt-out store.
 *
 * A row means "do not send this kind to this address". Magic links are never
 * stored, because they are always sent. A receipt row is kept, but the
 * service ignores it for a payment the recipient made.
 */
export interface EmailPreferenceStoreOptions {
  /** Injectable clock, so a test can check the recorded time. */
  now?: () => Date
}

export class EmailPreferenceStore {
  readonly #db: Db
  readonly #now: () => Date

  constructor(db: Db, options: EmailPreferenceStoreOptions = {}) {
    this.#db = db
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Turn one kind off for one address. A magic link, which includes a
   * password reset, cannot be turned off and is refused here.
   */
  optOut(to: string, kind: EmailKind): void {
    const checked = assertEmailKind(kind)
    const email = normalizeEmail(to, checked)
    if (checked === 'magic_link') {
      throw new EmailError(
        'always_sent',
        'A magic link or password reset is always sent, so it cannot be turned off.',
        checked,
      )
    }

    this.#db
      .prepare(
        `insert into email_optouts (email_normalized, kind, opted_out_at) values (?, ?, ?)
         on conflict (email_normalized, kind) do update set opted_out_at = excluded.opted_out_at`,
      )
      .run(email, checked, this.#now().getTime())
  }

  /** Turn one kind back on. Returns false when it was not off. */
  optIn(to: string, kind: EmailKind): boolean {
    const checked = assertEmailKind(kind)
    const email = normalizeEmail(to, checked)
    const result = this.#db
      .prepare('delete from email_optouts where email_normalized = ? and kind = ?')
      .run(email, checked)
    return result.changes > 0
  }

  /** True when this address has turned this kind off. Magic links are never off. */
  isOptedOut(to: string, kind: EmailKind): boolean {
    const checked = assertEmailKind(kind)
    if (checked === 'magic_link') return false
    const email = normalizeEmail(to, checked)
    return (
      this.#db
        .prepare('select 1 as found from email_optouts where email_normalized = ? and kind = ?')
        .get(email, checked) !== undefined
    )
  }

  /** Every kind this address has turned off, newest decision first. */
  optedOutKinds(to: string): EmailKind[] {
    const email = normalizeEmail(to)
    const rows = this.#db
      .prepare('select kind from email_optouts where email_normalized = ? order by opted_out_at desc, kind')
      .all(email) as Array<{ kind: EmailKind }>
    return rows.map((row) => row.kind)
  }

  /** Turn off every kind a person may turn off, leaving the magic link alone. */
  optOutOfOptionalKinds(to: string): void {
    this.optOut(to, 'invitation')
    this.optOut(to, 'receipt')
    this.optOut(to, 'admin_notice')
  }
}

// ---- composing ----------------------------------------------------------

const FIRST_LINE_SITE = `${SITE_NAME}: `

function composeMagicLink(request: MagicLinkEmail, to: string): OutgoingEmail {
  const purpose = oneOf(request.purpose, ['sign_in', 'password_reset'], 'purpose', 'magic_link')
  const link = webLink(request.link, 'magic_link')
  const expiresAt = timeValue(request.expiresAt, 'expiresAt', 'magic_link')

  const firstLine =
    purpose === 'password_reset'
      ? `${FIRST_LINE_SITE}Here is your password reset link.`
      : `${FIRST_LINE_SITE}Here is your sign-in link.`

  const text = [
    firstLine,
    '',
    purpose === 'password_reset'
      ? 'Follow the link below to set a new password for NameTempest. The link works once.'
      : 'Follow the link below to sign in to NameTempest. The link works once.',
    `Link: ${link}`,
    `The link expires at ${formatTime(expiresAt)}.`,
    '',
    'If you did not ask for this link, you can ignore this email.',
    '',
    'Magic links and password resets are always sent. They cannot be turned off.',
  ].join('\n')

  return { kind: 'magic_link', to, subject: firstLine, firstLine, text }
}

function composeInvitation(request: InvitationEmail, to: string): OutgoingEmail {
  const event = oneOf(request.event, ['invited', 'member_added', 'member_removed'], 'event', 'invitation')
  const organization = singleLine(request.organization, 'organization', 'invitation', 120)
  const link = request.link === undefined ? null : webLink(request.link, 'invitation')

  const reason =
    event === 'invited'
      ? 'You are invited to join a Studio organization.'
      : event === 'member_added'
        ? 'You were added to a Studio organization.'
        : 'You were removed from a Studio organization.'
  const firstLine = `${FIRST_LINE_SITE}${reason}`

  const lines = [firstLine, '', `Organization: ${organization}`]
  if (event === 'invited') {
    lines.push(
      link === null
        ? 'Ask the organization owner for an invitation link, then sign in to NameTempest.'
        : `Follow this link to join on NameTempest. The link works once.\nLink: ${link}`,
    )
  } else if (event === 'member_added') {
    lines.push(`Your Studio seat is ready. Sign in at ${SITE_DOMAIN} to work with the organization.`)
  } else {
    lines.push('Your own NameTempest account and projects are not deleted, and they stay yours.')
  }
  lines.push('', 'You can turn off invitation emails in your NameTempest account settings.')

  return { kind: 'invitation', to, subject: firstLine, firstLine, text: lines.join('\n') }
}

function composeReceipt(request: ReceiptEmail, to: string): OutgoingEmail {
  const event = oneOf(request.event, ['paid', 'payment_failed'], 'event', 'receipt')
  const item = oneOf(request.item, ['subscription', 'credit_pack'], 'item', 'receipt')
  const amountCents = wholeNumber(request.amountCents, 'amountCents', 'receipt', 0)
  const currency = currencyCode(request.currency)
  normalizeEmail(request.paidBy, 'receipt')

  const itemLabel = item === 'subscription' ? 'subscription' : 'credit pack'
  const firstLine =
    event === 'paid'
      ? `${FIRST_LINE_SITE}Your ${itemLabel} payment receipt.`
      : `${FIRST_LINE_SITE}Your ${itemLabel} payment did not go through.`

  const lines = [
    firstLine,
    '',
    `Item: ${receiptItemLabel(item)}`,
    `Amount: ${formatMoney(amountCents, currency)}`,
    event === 'paid' ? 'Payment: received.' : 'Payment: did not go through.',
  ]

  if (event === 'payment_failed') {
    lines.push(
      item === 'subscription'
        ? 'Your plan stays as it was while the payment is retried. You can update the payment method in your NameTempest account settings.'
        : 'No credits were added. You can update the payment method and try again in your NameTempest account settings.',
    )
  } else {
    lines.push(
      item === 'subscription'
        ? 'Your subscription is active. Thank you.'
        : 'Your credits are ready in your NameTempest account.',
    )
  }

  const ownPayment = normalizeEmail(request.paidBy, 'receipt') === to
  lines.push(
    '',
    ownPayment
      ? 'A receipt for a payment you made is always sent. It cannot be turned off.'
      : 'You can turn off receipts for payments you did not make in your NameTempest account settings.',
  )

  return { kind: 'receipt', to, subject: firstLine, firstLine, text: lines.join('\n') }
}

function composeAdminNotice(request: AdminNoticeEmail, to: string): OutgoingEmail {
  const event = oneOf(
    request.event,
    ['plan_changed', 'credits_changed', 'seats_changed', 'account_deletion_scheduled', 'account_deleted'],
    'event',
    'admin_notice',
  )
  const organization =
    request.organization === undefined ? null : singleLine(request.organization, 'organization', 'admin_notice', 120)
  const effectiveAt =
    request.effectiveAt === undefined ? null : timeValue(request.effectiveAt, 'effectiveAt', 'admin_notice')

  const reason =
    event === 'plan_changed'
      ? 'Your plan changed.'
      : event === 'credits_changed'
        ? 'Your credits changed.'
        : event === 'seats_changed'
          ? 'Your seats changed.'
          : event === 'account_deletion_scheduled'
            ? 'Your account is about to be deleted.'
            : 'Your account was deleted.'
  const firstLine = `${FIRST_LINE_SITE}${reason}`

  const lines = [firstLine, '']
  if (organization !== null) lines.push(`Organization: ${organization}`)

  if (event === 'account_deletion_scheduled') {
    lines.push('Your account and its projects will be removed at the time below.')
    if (effectiveAt !== null) lines.push(`When: ${formatTime(effectiveAt)}.`)
    lines.push('Sign in before then to keep your account and its projects.')
  } else if (event === 'account_deleted') {
    lines.push('Your account and its projects were removed, and this email confirms it.')
    if (effectiveAt !== null) lines.push(`When: ${formatTime(effectiveAt)}.`)
  } else {
    lines.push('The change is recorded in your NameTempest account.')
    if (effectiveAt !== null) lines.push(`When: ${formatTime(effectiveAt)}.`)
  }
  lines.push('', 'You can turn off admin notices in your NameTempest account settings.')

  return { kind: 'admin_notice', to, subject: firstLine, firstLine, text: lines.join('\n') }
}

// ---- validation helpers -------------------------------------------------

function refuseUnknownFields(raw: Record<string, unknown>, kind: EmailKind): void {
  const allowed = new Set(ALLOWED_FIELDS[kind])
  for (const field of Object.keys(raw)) {
    if (WORK_FIELDS.has(field)) {
      throw new EmailError(
        'invalid_details',
        'An email never carries a company description, a generated name or a domain result.',
        kind,
      )
    }
    if (!allowed.has(field)) {
      throw new EmailError('invalid_details', `A ${plainKind(kind)} does not carry a ${field} value.`, kind)
    }
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, kind: EmailKind): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new EmailError('invalid_details', `The ${field} of a ${plainKind(kind)} is not one the product sends.`, kind)
  }
  return value as T
}

function singleLine(value: unknown, field: string, kind: EmailKind, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new EmailError('invalid_details', `A ${plainKind(kind)} needs a ${field}.`, kind)
  }
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length === 0 || clean.length > maxLength) {
    throw new EmailError(
      'invalid_details',
      `The ${field} of a ${plainKind(kind)} must be between 1 and ${maxLength} characters.`,
      kind,
    )
  }
  return clean
}

function webLink(value: unknown, kind: EmailKind): string {
  if (typeof value !== 'string' || value.length > 2_048 || /\s/.test(value)) {
    throw new EmailError('invalid_details', 'The link in this email is not a web address.', kind)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new EmailError('invalid_details', 'The link in this email is not a web address.', kind)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new EmailError('invalid_details', 'The link in this email must be an http or https address.', kind)
  }
  return parsed.toString()
}

function timeValue(value: unknown, field: string, kind: EmailKind): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new EmailError(
      'invalid_details',
      `The ${field} of a ${plainKind(kind)} must be a time in milliseconds since the Unix epoch.`,
      kind,
    )
  }
  return value
}

function wholeNumber(value: unknown, field: string, kind: EmailKind, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new EmailError(
      'invalid_details',
      `The ${field} of a ${plainKind(kind)} must be a whole number of at least ${minimum}.`,
      kind,
    )
  }
  return value
}

function currencyCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new EmailError('invalid_details', 'A receipt needs a three-letter currency code.', 'receipt')
  }
  return value.trim().toUpperCase()
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

function formatTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace('.000Z', 'Z')
}

function receiptItemLabel(item: ReceiptItem): string {
  return item === 'subscription' ? 'Subscription' : 'Credit pack'
}

function plainKind(kind: EmailKind): string {
  switch (kind) {
    case 'magic_link':
      return 'magic link'
    case 'invitation':
      return 'invitation'
    case 'receipt':
      return 'receipt'
    case 'admin_notice':
      return 'admin notice'
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected email kind: ${String(value)}`)
}
