import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { openDatabase } from '../../server/db.ts'
import type { Db } from '../../server/db.ts'
import { AllowanceStore } from '../../server/allowance.ts'
import {
  EMAIL_KINDS,
  EmailError,
  EmailPreferenceStore,
  EmailProvider,
  MemoryEmailProvider,
  SITE_NAME,
  TransactionalEmailService,
  assertOutgoingEmail,
  composeEmail,
  isAlwaysSent,
  isEmailKind,
  normalizeEmail,
} from '../../server/email.ts'
import type {
  EmailKind,
  EmailProviderResult,
  OutgoingEmail,
  TransactionalEmail,
} from '../../server/email.ts'

const RECIPIENT = 'person@example.com'
const NOW = 1_786_000_000_000

function magicLink(overrides: Partial<TransactionalEmail> = {}): TransactionalEmail {
  return {
    kind: 'magic_link',
    to: RECIPIENT,
    purpose: 'sign_in',
    link: 'https://nametempest.com/sign-in/one-token',
    expiresAt: NOW + 15 * 60 * 1_000,
    ...overrides,
  } as TransactionalEmail
}

function invitation(overrides: Partial<TransactionalEmail> = {}): TransactionalEmail {
  return {
    kind: 'invitation',
    to: RECIPIENT,
    event: 'invited',
    organization: 'North Studio',
    link: 'https://nametempest.com/invite/one-token',
    ...overrides,
  } as TransactionalEmail
}

function receipt(overrides: Partial<TransactionalEmail> = {}): TransactionalEmail {
  return {
    kind: 'receipt',
    to: RECIPIENT,
    event: 'paid',
    item: 'subscription',
    amountCents: 1_200,
    currency: 'USD',
    paidBy: RECIPIENT,
    ...overrides,
  } as TransactionalEmail
}

function adminNotice(overrides: Partial<TransactionalEmail> = {}): TransactionalEmail {
  return {
    kind: 'admin_notice',
    to: RECIPIENT,
    event: 'plan_changed',
    ...overrides,
  } as TransactionalEmail
}

function withStore(t: { after(callback: () => void): void }): {
  db: Db
  preferences: EmailPreferenceStore
  provider: MemoryEmailProvider
  service: TransactionalEmailService
} {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const preferences = new EmailPreferenceStore(db, { now: () => new Date(NOW) })
  const provider = new MemoryEmailProvider()
  const service = new TransactionalEmailService({
    provider,
    preferences,
    retry: { attempts: 3, delaysMs: [0, 0], sleep: async () => {} },
  })
  return { db, preferences, provider, service }
}

function refuses(code: string) {
  return (error: unknown): boolean => error instanceof EmailError && error.code === code
}

describe('the four email kinds', () => {
  test('the only kinds are the four Email.sends names', () => {
    assert.deepEqual(EMAIL_KINDS, ['magic_link', 'invitation', 'receipt', 'admin_notice'])
    for (const kind of EMAIL_KINDS) assert.equal(isEmailKind(kind), true)
    assert.equal(isEmailKind('newsletter'), false)
    assert.equal(isEmailKind('product_announcement'), false)
    assert.equal(isEmailKind('reminder'), false)
  })

  test('a message that fits none of the four is refused before it reaches a provider', async (t) => {
    const { provider, service } = withStore(t)

    await assert.rejects(
      service.send({ kind: 'newsletter', to: RECIPIENT, subject: 'News' } as never),
      refuses('unsupported_kind'),
    )
    assert.equal(provider.sent.length, 0)
  })

  test('the provider boundary refuses an unknown kind and a body without the first line', async () => {
    const provider = new MemoryEmailProvider()

    await assert.rejects(
      provider.send({
        kind: 'newsletter',
        to: RECIPIENT,
        subject: 'News',
        firstLine: 'NameTempest: News',
        text: 'NameTempest: News',
      } as never),
      refuses('unsupported_kind'),
    )

    await assert.rejects(
      provider.send({
        kind: 'invitation',
        to: RECIPIENT,
        subject: 'Hello',
        firstLine: 'Hello',
        text: 'Hello',
      }),
      refuses('invalid_details'),
    )

    assert.equal(provider.sent.length, 0)
  })

  test('a password reset is the magic-link kind', async (t) => {
    const { provider, service } = withStore(t)

    const result = await service.send(
      magicLink({ purpose: 'password_reset', link: 'https://nametempest.com/reset/one-token' }),
    )

    assert.equal(result.status, 'sent')
    assert.equal(result.kind, 'magic_link')
    assert.equal(provider.sent.length, 1)
    assert.match(provider.sent[0].firstLine, /password reset link/)
  })

  test('a magic link send never spends the free allowance', async (t) => {
    const { db, service } = withStore(t)
    const allowance = new AllowanceStore(db)
    const subject = { kind: 'device' as const, id: 'device-1' }
    const before = allowance.allowance(subject)

    assert.equal((await service.send(magicLink())).status, 'sent')

    const after = allowance.allowance(subject)
    assert.deepEqual(after.used, before.used)
    assert.deepEqual(after.remaining, before.remaining)
  })
})

describe('the first line and the work it must never carry', () => {
  test('every message names the site and its reason on the first line', () => {
    const messages = [
      composeEmail(magicLink()),
      composeEmail(magicLink({ purpose: 'password_reset' })),
      composeEmail(invitation()),
      composeEmail(invitation({ event: 'member_added' })),
      composeEmail(invitation({ event: 'member_removed' })),
      composeEmail(receipt()),
      composeEmail(receipt({ event: 'payment_failed' })),
      composeEmail(adminNotice()),
      composeEmail(adminNotice({ event: 'account_deletion_scheduled', effectiveAt: NOW + 86_400_000 })),
      composeEmail(adminNotice({ event: 'account_deleted' })),
    ]

    for (const message of messages) {
      const firstLine = message.text.split('\n')[0]
      assert.equal(firstLine, message.firstLine)
      assert.equal(message.subject, message.firstLine)
      assert.ok(
        message.firstLine.startsWith(`${SITE_NAME}: `),
        `first line must name the site: ${message.firstLine}`,
      )
      assert.ok(message.firstLine.length > SITE_NAME.length + 2, 'first line must give the reason')
    }
  })

  test('a company description, a generated name or a domain result is refused by name', () => {
    const cases: Array<[string, unknown]> = [
      ['description', 'A bakery with a long room.'],
      ['companyDescription', 'A bakery with a long room.'],
      ['candidate', 'Quillstead'],
      ['candidateName', 'Quillstead'],
      ['generatedName', 'Quillstead'],
      ['name', 'Quillstead'],
      ['domain', 'quillstead.com'],
      ['domainResult', 'quillstead.com is available'],
      ['project', 'Secret project'],
      ['notes', 'A private note'],
    ]

    for (const [field, value] of cases) {
      const request = { ...invitation(), [field]: value }
      assert.throws(
        () => composeEmail(request as never),
        refuses('invalid_details'),
        `${field} must be refused`,
      )
    }
  })

  test('a field the kind does not allow is refused, so nothing is smuggled through', () => {
    assert.throws(
      () => composeEmail({ ...receipt(), description: 'We build things.' } as never),
      refuses('invalid_details'),
    )
    assert.throws(
      () => composeEmail({ ...adminNotice(), candidateName: 'Quillstead' } as never),
      refuses('invalid_details'),
    )
    assert.throws(
      () => composeEmail({ ...invitation(), html: '<p>A promotion</p>' } as never),
      refuses('invalid_details'),
    )
  })

  test('the provider boundary refuses an extra field as well as a work field', () => {
    const message = composeEmail(invitation())

    assert.throws(() => assertOutgoingEmail({ ...message, html: '<p>Hello</p>' } as never), refuses('invalid_details'))
    assert.throws(
      () => assertOutgoingEmail({ ...message, domainResult: 'quillstead.com is free' } as never),
      refuses('invalid_details'),
    )
    assert.throws(
      () => assertOutgoingEmail({ ...message, text: 'NameTempest: Hello\n\nBody' } as never),
      refuses('invalid_details'),
    )
  })

  test('the provider boundary needs a reason and a one-line subject', () => {
    const message = composeEmail(invitation())

    assert.throws(
      () => assertOutgoingEmail({ ...message, firstLine: `${SITE_NAME}:  `, text: `${SITE_NAME}:  ` } as never),
      refuses('invalid_details'),
    )
    assert.throws(
      () => assertOutgoingEmail({ ...message, subject: `${SITE_NAME}: Hello\nBcc: else@example.com` }),
      refuses('invalid_details'),
    )
    assert.throws(
      () => assertOutgoingEmail({ ...message, subject: `${SITE_NAME}: Hello\rBcc: else@example.com` }),
      refuses('invalid_details'),
    )
  })

  test('bad details are refused for every kind before a provider sees them', async (t) => {
    const { provider, service } = withStore(t)

    const bad: Array<[string, TransactionalEmail]> = [
      ['purpose', magicLink({ purpose: 'welcome' as never })],
      ['link scheme', magicLink({ link: 'javascript:alert(1)' })],
      ['expiry', magicLink({ expiresAt: 0 })],
      ['invitation event', invitation({ event: 'promoted' as never })],
      ['organization', invitation({ organization: '   ' })],
      ['invitation link', invitation({ link: 'not a web address' })],
      ['receipt event', receipt({ event: 'refunded' as never })],
      ['receipt item', receipt({ item: 'addon' as never })],
      ['amount', receipt({ amountCents: -1 })],
      ['fractional amount', receipt({ amountCents: 1.5 })],
      ['currency', receipt({ currency: 'US' })],
      ['admin notice event', adminNotice({ event: 'promotion' as never })],
      ['effective time', adminNotice({ effectiveAt: -2 })],
    ]

    for (const [label, request] of bad) {
      assert.throws(() => composeEmail(request), refuses('invalid_details'), label)
    }

    for (const [, request] of bad) {
      await assert.rejects(service.send(request), refuses('invalid_details'))
    }
    assert.equal(provider.sent.length, 0)
  })

  test('an invalid kind is refused by composeEmail too', () => {
    assert.throws(
      () => composeEmail({ kind: 'promotion', to: RECIPIENT } as never),
      refuses('unsupported_kind'),
    )
  })

  test('an address is trimmed and lower-cased before it is used', async (t) => {
    const { provider, service } = withStore(t)
    const result = await service.send(magicLink({ to: '  PERSON@Example.COM ' }))

    assert.equal(result.to, RECIPIENT)
    assert.equal(provider.sent[0].to, RECIPIENT)
    assert.equal(normalizeEmail(' PERSON@Example.COM '), RECIPIENT)
  })
})

describe('opting out', () => {
  test('an invitation or an admin notice is suppressed without asking the provider', async (t) => {
    const { preferences, provider, service } = withStore(t)

    preferences.optOut(' Person@Example.COM ', 'invitation')
    preferences.optOut(RECIPIENT, 'admin_notice')

    const invitationResult = await service.send(invitation())
    const noticeResult = await service.send(adminNotice())

    assert.equal(invitationResult.status, 'suppressed')
    assert.equal(invitationResult.attempts, 0)
    assert.equal(noticeResult.status, 'suppressed')
    assert.equal(provider.sent.length, 0)
  })

  test('turning a kind back on sends it again', async (t) => {
    const { preferences, provider, service } = withStore(t)

    preferences.optOut(RECIPIENT, 'invitation')
    assert.equal((await service.send(invitation())).status, 'suppressed')
    assert.equal(preferences.optIn(RECIPIENT, 'invitation'), true)
    assert.equal((await service.send(invitation())).status, 'sent')
    assert.equal(provider.sent.length, 1)
  })

  test('a magic link cannot be turned off', async (t) => {
    const { preferences, provider, service } = withStore(t)

    assert.throws(() => preferences.optOut(RECIPIENT, 'magic_link'), refuses('always_sent'))
    assert.equal(preferences.isOptedOut(RECIPIENT, 'magic_link'), false)

    const result = await service.send(magicLink())
    assert.equal(result.status, 'sent')
    assert.equal(provider.sent.length, 1)
  })

  test("a receipt for the recipient's own payment is always sent", async (t) => {
    const { preferences, provider, service } = withStore(t)

    preferences.optOut(RECIPIENT, 'receipt')
    assert.equal(preferences.isOptedOut(RECIPIENT, 'receipt'), true)
    assert.equal(isAlwaysSent('receipt', RECIPIENT, RECIPIENT), true)

    const result = await service.send(receipt())
    assert.equal(result.status, 'sent')
    assert.equal(provider.sent.length, 1)
  })

  test("a receipt for someone else's payment can be turned off", async (t) => {
    const { preferences, provider, service } = withStore(t)

    preferences.optOut(RECIPIENT, 'receipt')
    assert.equal(isAlwaysSent('receipt', RECIPIENT, 'payer@example.com'), false)

    const result = await service.send(receipt({ paidBy: 'payer@example.com' }))
    assert.equal(result.status, 'suppressed')
    assert.equal(provider.sent.length, 0)
  })

  test('a receipt for someone else\'s payment is sent when it is not turned off', async (t) => {
    const { provider, service } = withStore(t)

    const result = await service.send(receipt({ paidBy: 'payer@example.com' }))

    assert.equal(result.status, 'sent')
    assert.equal(provider.sent.length, 1)
  })

  test('an always-sent check still needs a usable address', () => {
    assert.throws(() => isAlwaysSent('magic_link', 'not-an-address'), refuses('invalid_recipient'))
    assert.throws(
      () => isAlwaysSent('receipt', RECIPIENT, 'not-an-address'),
      refuses('invalid_recipient'),
    )
  })

  test('turning off every optional kind leaves the magic link alone', async (t) => {
    const { preferences, provider, service } = withStore(t)

    preferences.optOutOfOptionalKinds(RECIPIENT)
    assert.deepEqual(preferences.optedOutKinds(RECIPIENT).sort(), ['admin_notice', 'invitation', 'receipt'])

    assert.equal((await service.send(invitation())).status, 'suppressed')
    assert.equal((await service.send(adminNotice())).status, 'suppressed')
    assert.equal((await service.send(receipt({ paidBy: 'payer@example.com' }))).status, 'suppressed')
    assert.equal((await service.send(magicLink())).status, 'sent')
    assert.equal(provider.sent.length, 1)
  })
})

describe('retrying a failed send', () => {
  class FlakyProvider extends EmailProvider {
    readonly sent: OutgoingEmail[] = []
    failuresLeft: number
    calls = 0

    constructor(failures: number) {
      super()
      this.failuresLeft = failures
    }

    protected deliver(message: OutgoingEmail): EmailProviderResult {
      this.calls++
      if (this.failuresLeft > 0) {
        this.failuresLeft--
        throw new Error('The provider is unavailable.')
      }
      this.sent.push({ ...message })
      return { messageId: `flaky-${this.calls}` }
    }
  }

  function serviceFor(provider: EmailProvider, db: Db, attempts = 3): TransactionalEmailService {
    return new TransactionalEmailService({
      provider,
      preferences: new EmailPreferenceStore(db, { now: () => new Date(NOW) }),
      retry: { attempts, delaysMs: [10, 20], sleep: async () => {} },
    })
  }

  test('a provider that fails twice is tried a third time and the message is sent', async (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const provider = new FlakyProvider(2)
    const service = serviceFor(provider, db)

    const result = await service.send(receipt())

    assert.equal(result.status, 'sent')
    assert.equal(result.attempts, 3)
    assert.equal(provider.calls, 3)
    assert.equal(provider.sent.length, 1)
    assert.equal(provider.sent[0].kind, 'receipt')
  })

  test('a send that never succeeds fails plainly after the last retry', async (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const provider = new FlakyProvider(10)
    const service = serviceFor(provider, db)

    await assert.rejects(service.send(invitation()), refuses('delivery_failed'))
    assert.equal(provider.calls, 3)
    assert.equal(provider.sent.length, 0)
  })

  test('one attempt means one provider call', async (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const provider = new FlakyProvider(1)
    const service = serviceFor(provider, db, 1)

    await assert.rejects(service.send(adminNotice()), refuses('delivery_failed'))
    assert.equal(provider.calls, 1)
  })

  test('the wait between tries follows the configured delays and reuses the last one', async (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const waits: number[] = []
    const provider = new FlakyProvider(10)
    const service = new TransactionalEmailService({
      provider,
      preferences: new EmailPreferenceStore(db, { now: () => new Date(NOW) }),
      retry: { attempts: 4, delaysMs: [10, 20], sleep: async (milliseconds) => void waits.push(milliseconds) },
    })

    await assert.rejects(service.send(invitation()), refuses('delivery_failed'))
    assert.equal(provider.calls, 4)
    assert.deepEqual(waits, [10, 20, 20])
  })

  test('a bad retry policy is refused when the service is built', () => {
    const db = openDatabase(':memory:')
    try {
      const preferences = new EmailPreferenceStore(db)
      const provider = new MemoryEmailProvider()

      assert.throws(
        () => new TransactionalEmailService({ provider, preferences, retry: { attempts: 0 } }),
        RangeError,
      )
      assert.throws(
        () => new TransactionalEmailService({ provider, preferences, retry: { attempts: 1, delaysMs: [-1] } }),
        RangeError,
      )
      assert.throws(
        () =>
          new TransactionalEmailService({
            provider,
            preferences: undefined as never,
          }),
        refuses('preferences_required'),
      )
      assert.throws(
        () =>
          new TransactionalEmailService({
            provider: undefined as never,
            preferences,
          }),
        refuses('provider_required'),
      )
      assert.throws(() => new TransactionalEmailService(null as never), refuses('provider_required'))
    } finally {
      db.close()
    }
  })
})

describe('opt-out storage', () => {
  test('a fresh database has every kind on', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const preferences = new EmailPreferenceStore(db)

    for (const kind of EMAIL_KINDS) {
      assert.equal(preferences.isOptedOut(RECIPIENT, kind), false)
    }
    assert.deepEqual(preferences.optedOutKinds(RECIPIENT), [])
  })

  test('one address decisions do not touch another address', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const preferences = new EmailPreferenceStore(db)

    preferences.optOut('one@example.com', 'invitation')
    assert.equal(preferences.isOptedOut('one@example.com', 'invitation'), true)
    assert.equal(preferences.isOptedOut('two@example.com', 'invitation'), false)
  })

  test('turning off the same kind twice keeps one row', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const preferences = new EmailPreferenceStore(db)

    preferences.optOut(RECIPIENT, 'invitation')
    preferences.optOut(RECIPIENT, 'invitation')

    const row = db
      .prepare('select count(*) as count from email_optouts where email_normalized = ? and kind = ?')
      .get(RECIPIENT, 'invitation') as { count: number }
    assert.equal(row.count, 1)
  })

  test('a kind outside the four and a bad address are refused', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const preferences = new EmailPreferenceStore(db)

    assert.throws(() => preferences.optOut(RECIPIENT, 'newsletter' as never), refuses('unsupported_kind'))
    assert.throws(() => preferences.optIn(RECIPIENT, 'newsletter' as never), refuses('unsupported_kind'))
    assert.throws(() => preferences.isOptedOut(RECIPIENT, 'newsletter' as never), refuses('unsupported_kind'))
    assert.throws(() => preferences.optOut('not-an-address', 'invitation'), refuses('invalid_recipient'))
    assert.throws(() => preferences.isOptedOut('not-an-address', 'magic_link'), refuses('invalid_recipient'))

    assert.deepEqual(preferences.optedOutKinds(RECIPIENT), [])
  })

  test('turning on a kind that was never off reports that nothing changed', (t) => {
    const db = openDatabase(':memory:')
    t.after(() => db.close())
    const preferences = new EmailPreferenceStore(db)

    assert.equal(preferences.optIn(RECIPIENT, 'admin_notice'), false)
    assert.deepEqual(preferences.optedOutKinds(RECIPIENT), [])
  })
})

describe('email kinds stay inside the four', () => {
  test('every kind composes a plain-text message and no kind adds HTML', () => {
    for (const kind of EMAIL_KINDS as readonly EmailKind[]) {
      const request: TransactionalEmail =
        kind === 'magic_link'
          ? magicLink()
          : kind === 'invitation'
            ? invitation()
            : kind === 'receipt'
              ? receipt()
              : adminNotice()
      const message = composeEmail(request)
      assert.equal(message.kind, kind)
      assert.equal(typeof message.text, 'string')
      assert.ok(!('html' in message), 'the service sends plain text only')
    }
  })
})
