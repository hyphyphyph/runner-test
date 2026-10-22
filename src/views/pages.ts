// Sign-in, the magic link landing, invitations, the account page, plans and
// the studio page.

import { ApiError, api } from '../api.ts'
import { allowanceText, clearProblem, go, notice, refreshMe, showProblem, state } from '../app.ts'
import { confirmDialog, day, h, money, mount, plural, when } from '../ui.ts'

interface SignInResult {
  attached: number
  restored: boolean
  conflicts: number
  next?: string | null
}

async function afterSignIn(r: SignInResult, next: string | null): Promise<void> {
  await refreshMe()
  const parts = ['You are signed in.']
  if (r.restored) parts.push('Your account was scheduled for deletion; signing in restored it in full.')
  if (r.attached) parts.push(`${plural(r.attached, 'project')} from this browser ${r.attached === 1 ? 'is' : 'are'} now kept on your account.`)
  if (r.conflicts) parts.push('A project has the same name as one already on your account; open it to choose which copy to keep.')
  notice(parts.join(' '))
  go(next ?? r.next ?? '#/')
}

export function signInView(main: HTMLElement, next: string | null): void {
  if (state.me?.account) {
    go(next ?? '#/account')
    return
  }
  let mode: 'link' | 'password' | 'signup' = 'link'
  const render = () => {
    const email = h('input', { type: 'email', required: true, autocomplete: 'email', maxlength: 254 })
    const password = h('input', {
      type: 'password',
      required: true,
      minlength: 10,
      autocomplete: mode === 'signup' ? 'new-password' : 'current-password',
    })
    const msg = h('div', { role: 'status' })
    const submit = async (e: Event) => {
      e.preventDefault()
      try {
        if (mode === 'link') {
          await api('POST', '/api/auth/magic', { email: email.value, next })
          clearProblem()
          mount(msg, h('p', { class: 'notice' }, `We sent a sign-in link to ${email.value}. It works once and expires in 15 minutes. Only the newest link works.`))
        } else {
          const r = await api<SignInResult>('POST', mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
            email: email.value,
            password: password.value,
          })
          clearProblem()
          await afterSignIn(r, next)
        }
      } catch (err) {
        showProblem(err, () => void submit(e))
      }
    }
    const tab = (m: typeof mode, label: string) => h('button', { class: 'tab', 'aria-pressed': String(mode === m), onclick: () => ((mode = m), render()) }, label)
    mount(
      main,
      h(
        'section',
        { class: 'card narrow' },
        h('h1', {}, 'Sign in'),
        h('p', { class: 'muted' }, 'Signing in keeps your projects on every device, lets you subscribe or buy credits, and lets you join a studio. Projects made in this browser come with you.'),
        h('div', { class: 'row tabs', role: 'group' }, tab('link', 'Email me a link'), tab('password', 'Password'), tab('signup', 'Create an account')),
        h(
          'form',
          { class: 'stack', onsubmit: submit },
          h('label', {}, 'Email address', email),
          mode !== 'link' ? h('label', {}, mode === 'signup' ? 'Choose a password (at least 10 characters)' : 'Password', password) : null,
          h('button', { class: 'primary', type: 'submit' }, mode === 'link' ? 'Send sign-in link' : mode === 'signup' ? 'Create account' : 'Sign in'),
        ),
        msg,
      ),
    )
  }
  render()
}

export async function magicView(main: HTMLElement, token: string): Promise<void> {
  mount(main, h('section', { class: 'card narrow' }, h('p', {}, 'Signing you in…')))
  try {
    const r = await api<SignInResult>('POST', '/api/auth/magic/verify', { token })
    await afterSignIn(r, null)
  } catch (e) {
    const email = h('input', { type: 'email', required: true, autocomplete: 'email' })
    const msg = h('div', { role: 'status' })
    mount(
      main,
      h(
        'section',
        { class: 'card narrow' },
        h('h1', {}, 'This link did not work'),
        h('p', {}, e instanceof Error ? e.message : 'This sign-in link is not valid.'),
        h(
          'form',
          {
            class: 'stack',
            onsubmit: async (ev: Event) => {
              ev.preventDefault()
              try {
                await api('POST', '/api/auth/magic', { email: email.value })
                mount(msg, h('p', { class: 'notice' }, `A fresh link is on its way to ${email.value}.`))
              } catch (err) {
                showProblem(err)
              }
            },
          },
          h('label', {}, 'Email address', email),
          h('button', { class: 'primary', type: 'submit' }, 'Send a fresh link'),
        ),
        msg,
      ),
    )
  }
}

export async function inviteView(main: HTMLElement, token: string): Promise<void> {
  let info: { email: string; org: string }
  try {
    info = await api('GET', `/api/invite/${token}`)
  } catch (e) {
    mount(main, h('section', { class: 'card narrow' }, h('h1', {}, 'Invitation'), h('p', {}, (e as Error).message)))
    return
  }
  const acc = state.me?.account
  const accept = async () => {
    try {
      await api('POST', `/api/invite/${token}/accept`)
      clearProblem()
      await refreshMe()
      notice(`You joined ${info.org}.`)
      go('#/studio')
    } catch (e) {
      showProblem(e, () => void accept())
    }
  }
  mount(
    main,
    h(
      'section',
      { class: 'card narrow' },
      h('h1', {}, `Join ${info.org}`),
      h('p', {}, `This invitation was sent to ${info.email}.`),
      acc
        ? acc.email === info.email
          ? h('button', { class: 'primary', onclick: () => void accept() }, `Join ${info.org}`)
          : h('p', {}, `You are signed in as ${acc.email}. Sign out and sign in as ${info.email} to accept.`)
        : h(
            'div',
            { class: 'stack' },
            h('p', {}, 'Sign in or create an account with that address, with a password or an email link. You come back here afterwards.'),
            h('a', { class: 'button primary', href: `#/signin?next=${encodeURIComponent('#/invite/' + token)}` }, 'Sign in to accept'),
          ),
    ),
  )
}

// --- account ----------------------------------------------------------------------------

const EMAIL_LABELS: Record<string, string> = {
  membership: 'When someone is added to or removed from your organization',
  'payment-failed': 'When a payment does not go through',
  'admin-notice': 'When an operator change touches what you paid for',
  'deletion-soon': 'Before your account is deleted, and once it has been',
}

export async function accountView(main: HTMLElement, params: URLSearchParams): Promise<void> {
  const me = state.me
  if (!me?.account) {
    go('#/signin')
    return
  }
  const acc = me.account
  if (params.get('paid')) {
    notice('Thank you. Your payment is being confirmed by the payment provider; this page updates once it is.')
    setTimeout(() => void refreshMe().then(() => accountView(main, new URLSearchParams())), 3000)
  }
  const signOut = async () => {
    try {
      await api('POST', '/api/auth/logout')
      clearProblem()
      await refreshMe()
      notice('You are signed out. This browser counts against its own free allowance again.')
      go('#/')
    } catch (e) {
      showProblem(e, () => void signOut())
    }
  }
  const prefs = h(
    'fieldset',
    {},
    h('legend', {}, 'Emails you receive'),
    h('p', { class: 'muted small' }, 'Sign-in links and receipts for payments you make are always sent. NameTempest never sends newsletters, promotions or reminders.'),
    Object.entries(EMAIL_LABELS).map(([k, label]) =>
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: acc.emailPrefs[k] !== false,
          onchange: async (e: Event) => {
            try {
              await api('POST', '/api/account/emails', { [k]: (e.target as HTMLInputElement).checked })
              await refreshMe()
              notice('Saved.')
            } catch (err) {
              showProblem(err)
            }
          },
        }),
        label,
      ),
    ),
  )
  const pw = h('input', { type: 'password', minlength: 10, autocomplete: 'new-password', required: true })
  const setPassword = async (e: Event) => {
    e.preventDefault()
    try {
      await api('POST', '/api/auth/password', { password: pw.value })
      pw.value = ''
      clearProblem()
      notice('Password saved.')
      await refreshMe()
    } catch (err) {
      showProblem(err)
    }
  }
  const del = async () => {
    try {
      const preview = await api<{ projects: number; credits: number; ownsOrg: string | null; removeOn: number }>('GET', '/api/account/deletion')
      if (preview.ownsOrg) {
        showProblem(new Error(`You own the studio “${preview.ownsOrg}”. Close it, or hand it to another member on the Studio page, before deleting your account.`))
        return
      }
      const ok = await confirmDialog(
        'Delete your account?',
        h(
          'div',
          {},
          h(
            'p',
            {},
            `This removes your ${plural(preview.projects, 'project')}, their names and notes, your counters${preview.credits ? `, your ${plural(preview.credits, 'credit')}` : ''} and your sign-in.`,
          ),
          h('p', {}, `You can restore everything by signing in before ${day(preview.removeOn)}. After that, nothing is kept and it cannot be restored.`),
          h('p', { class: 'muted small' }, 'Cancel any subscription with the payment provider first if you have one.'),
        ),
        'Delete my account',
      )
      if (!ok) return
      await api('POST', '/api/account/delete')
      await refreshMe()
      notice('Your account is scheduled for deletion. We sent you an email with the date.')
      go('#/')
    } catch (e) {
      showProblem(e, () => void del())
    }
  }
  const manage = async () => {
    try {
      const r = await api<{ url: string }>('POST', '/api/billing/portal')
      location.href = r.url
    } catch (e) {
      showProblem(e, () => void manage())
    }
  }
  mount(
    main,
    h(
      'section',
      { class: 'card' },
      h('h1', {}, 'Your account'),
      h('p', {}, acc.email),
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Plan'),
        h('dd', {}, acc.plan === 'free' ? 'Free allowance' : acc.plan === 'pro' ? 'Pro' : `Studio (${acc.org?.name})`),
        h('dt', {}, 'This month'),
        h('dd', {}, allowanceText(me.allowance)),
        h('dt', {}, 'Credits'),
        h('dd', {}, `${acc.credits} (never expire)`),
        h('dt', {}, 'Refreshes'),
        h('dd', {}, day(me.allowance.resetsAt)),
      ),
      h(
        'div',
        { class: 'row wrap' },
        h('a', { class: 'button', href: '#/plans' }, acc.plan === 'free' ? 'See plans' : 'Plans and credits'),
        acc.plan !== 'free' ? h('button', { onclick: () => void manage() }, 'Manage billing') : null,
        h('button', { onclick: () => void signOut() }, 'Sign out'),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, acc.hasPassword ? 'Change password' : 'Add a password'),
      h('form', { class: 'row wrap', onsubmit: setPassword }, h('label', {}, 'New password', pw), h('button', { type: 'submit' }, 'Save password')),
    ),
    h('section', { class: 'card' }, prefs),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Your work'),
      h('p', {}, 'Take every project out as a spreadsheet file at any time.'),
      h('a', { class: 'button', href: '/api/export?format=csv', download: true }, 'Download every project (CSV)'),
      h('h2', {}, 'Delete account'),
      h('p', { class: 'muted' }, 'Deleting removes your projects, counters and sign-in. It can be undone by signing in within 30 days.'),
      h('button', { class: 'danger', onclick: () => void del() }, 'Delete my account…'),
    ),
  )
}

// --- plans -----------------------------------------------------------------------------------

interface Plans {
  currency: string
  mode: 'stripe' | 'fake' | 'off'
  pro: { price: number; period: string; includes: string[] }
  studio: { pricePerSeat: number; minSeats: number; period: string; includes: string[] }
  credits: { packSize: number; packPrice: number; meaning: string }
}

export async function plansView(main: HTMLElement): Promise<void> {
  let p: Plans
  try {
    p = await api<Plans>('GET', '/api/plans')
  } catch (e) {
    showProblem(e, () => void plansView(main))
    return
  }
  const acc = state.me?.account
  const buy = async (body: Record<string, unknown>) => {
    if (!acc) {
      go('#/signin?next=' + encodeURIComponent('#/plans'))
      return
    }
    try {
      const r = await api<{ url?: string; done?: boolean }>('POST', '/api/billing/checkout', body)
      clearProblem()
      if (r.url) location.href = r.url
      else {
        await refreshMe()
        notice('Payment confirmed.')
        go('#/account')
      }
    } catch (e) {
      showProblem(e, () => void buy(body))
    }
  }
  const seats = h('input', { type: 'number', min: p.studio.minSeats, value: p.studio.minSeats, step: 1, required: true })
  const orgName = h('input', { type: 'text', maxlength: 120, required: true, placeholder: 'Your studio’s name' })
  const packs = h('input', { type: 'number', min: 1, max: 50, value: 1, step: 1, required: true })
  const studioTotal = h('span', { class: 'muted small' })
  const updateTotal = () => (studioTotal.textContent = `${money(p.studio.pricePerSeat * Math.max(p.studio.minSeats, Number(seats.value) || 0), p.currency)} a month in total`)
  seats.addEventListener('input', updateTotal)
  updateTotal()
  const disc = p.pro.price > p.studio.pricePerSeat ? Math.round((1 - p.studio.pricePerSeat / p.pro.price) * 100) : 0
  mount(
    main,
    h('h1', {}, 'Plans'),
    h('p', { class: 'muted' }, 'You are never charged while your free allowance lasts, unless you choose to buy. Prices are per month; you can cancel at any time with the payment provider.'),
    p.mode === 'off' ? h('p', { class: 'banner' }, 'Payments are not set up on this server yet.') : null,
    h(
      'div',
      { class: 'plans' },
      h(
        'section',
        { class: 'card plan' },
        h('h2', {}, 'Pro'),
        h('p', { class: 'price' }, money(p.pro.price, p.currency), h('span', { class: 'muted' }, ' a month, one person')),
        h('ul', {}, p.pro.includes.map((i) => h('li', {}, i))),
        acc?.plan === 'pro'
          ? h('p', { class: 'tag kept' }, 'Your plan')
          : h('button', { class: 'primary', disabled: !!acc?.org, onclick: () => void buy({ kind: 'pro' }) }, acc ? 'Subscribe to Pro' : 'Sign in to subscribe'),
      ),
      h(
        'section',
        { class: 'card plan' },
        h('h2', {}, 'Studio'),
        h(
          'p',
          { class: 'price' },
          money(p.studio.pricePerSeat, p.currency),
          h('span', { class: 'muted' }, ` a month per seat, at least ${p.studio.minSeats} seats`),
        ),
        disc ? h('p', { class: 'small' }, `A ${disc}% per-seat volume discount on the Pro price, because a studio buys several seats at once.`) : null,
        h('ul', {}, p.studio.includes.map((i) => h('li', {}, i))),
        acc?.org
          ? h('p', { class: 'tag kept' }, `You are in ${acc.org.name}`)
          : h(
              'form',
              {
                class: 'stack',
                onsubmit: (e: Event) => {
                  e.preventDefault()
                  void buy({ kind: 'studio', seats: Number(seats.value), orgName: orgName.value })
                },
              },
              h('label', {}, 'Studio name', orgName),
              h('label', {}, 'Seats', seats),
              studioTotal,
              h('button', { class: 'primary', type: 'submit' }, acc ? 'Start a Studio' : 'Sign in to start a Studio'),
            ),
      ),
      h(
        'section',
        { class: 'card plan' },
        h('h2', {}, 'Credits'),
        h('p', { class: 'price' }, money(p.credits.packPrice, p.currency), h('span', { class: 'muted' }, ` for ${p.credits.packSize} credits`)),
        h('p', {}, p.credits.meaning),
        h('p', { class: 'muted small' }, 'Credits pay for generation rounds only, and belong to your account, not to a device. A one-off payment, no subscription.'),
        h(
          'form',
          {
            class: 'row wrap',
            onsubmit: (e: Event) => {
              e.preventDefault()
              void buy({ kind: 'credits', packs: Number(packs.value) })
            },
          },
          h('label', {}, 'Packs', packs),
          h('button', { type: 'submit' }, acc ? 'Buy credits' : 'Sign in to buy credits'),
        ),
      ),
    ),
  )
}

// --- studio --------------------------------------------------------------------------------

interface OrgView {
  id: string
  name: string
  role: 'owner' | 'member'
  seats: number
  active: boolean
  credits: number
  members: { id: string; email: string; role: string; joined_at: number }[]
  invites: { id: string; email: string; created_at: number }[]
  usage: null | { rounds: { used: number; limit: number }; revisions: { used: number; limit: number }; checks: { used: number; limit: number } }
}

export async function studioView(main: HTMLElement): Promise<void> {
  let org: OrgView | null
  try {
    org = await api<OrgView | null>('GET', '/api/org')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return go('#/signin')
    showProblem(e, () => void studioView(main))
    return
  }
  if (!org) {
    mount(main, h('section', { class: 'card' }, h('h1', {}, 'Studio'), h('p', {}, 'You are not in a Studio organization.'), h('a', { class: 'button', href: '#/plans' }, 'See the Studio plan')))
    return
  }
  const o = org
  const owner = o.role === 'owner'
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn()
      clearProblem()
      notice(done)
      await refreshMe()
      await studioView(main)
    } catch (e) {
      showProblem(e, () => void act(fn, done))
    }
  }
  const email = h('input', { type: 'email', required: true })
  const seats = h('input', { type: 'number', min: Math.max(3, o.members.length), value: o.seats, step: 1 })
  const free = o.seats - o.members.length
  mount(
    main,
    h(
      'section',
      { class: 'card' },
      h('h1', {}, o.name),
      !o.active ? h('p', { class: 'banner' }, 'The Studio subscription is not active. Shared projects are hidden until it is renewed; nothing has been deleted.') : null,
      h('p', {}, `${plural(o.members.length, 'member')} · ${plural(o.seats, 'seat')} · ${plural(free, 'free seat')}`),
      o.usage
        ? h(
            'p',
            { class: 'muted' },
            `This month the studio used ${o.usage.rounds.used} of ${o.usage.rounds.limit} rounds, ${o.usage.revisions.used} of ${o.usage.revisions.limit} revisions and ${o.usage.checks.used} of ${o.usage.checks.limit} checks. Studio credits: ${o.credits}.`,
          )
        : null,
      h('h2', {}, 'Members'),
      h(
        'ul',
        { class: 'members' },
        o.members.map((m) =>
          h(
            'li',
            { class: 'row between wrap' },
            h('span', {}, m.email, ' ', h('span', { class: 'tag' }, m.role), h('span', { class: 'muted small' }, ` joined ${when(m.joined_at)}`)),
            owner && m.role !== 'owner'
              ? h(
                  'span',
                  { class: 'row' },
                  h(
                    'button',
                    {
                      class: 'small',
                      onclick: async () => {
                        if (await confirmDialog('Hand over the studio?', h('p', {}, `${m.email} becomes the owner and pays for every seat. You stay as a member.`), 'Hand over'))
                          void act(() => api('POST', '/api/org/transfer', { memberId: m.id }), 'Ownership handed over.')
                      },
                    },
                    'Make owner',
                  ),
                  h(
                    'button',
                    {
                      class: 'small danger',
                      onclick: async () => {
                        if (
                          await confirmDialog(
                            'Remove this member?',
                            h('p', {}, `${m.email} loses access to shared projects at once. Their private projects in the studio are offered to you; nothing is deleted without telling you.`),
                            'Remove',
                          )
                        )
                          void act(() => api('POST', `/api/org/members/${m.id}/remove`), 'Member removed. Their seat is free.')
                      },
                    },
                    'Remove',
                  ),
                )
              : null,
          ),
        ),
      ),
      owner
        ? [
            h('h2', {}, 'Invite a member'),
            free <= 0 ? h('p', { class: 'muted small' }, 'Every seat is taken. Add a seat so an invitation can be accepted.') : null,
            h(
              'form',
              {
                class: 'row wrap',
                onsubmit: (e: Event) => {
                  e.preventDefault()
                  void act(() => api('POST', '/api/org/invite', { email: email.value }), `Invitation sent to ${email.value}.`)
                },
              },
              h('label', {}, 'Email address', email),
              h('button', { type: 'submit' }, 'Send invitation'),
            ),
            o.invites.length
              ? h(
                  'ul',
                  {},
                  o.invites.map((i) =>
                    h(
                      'li',
                      { class: 'row' },
                      `${i.email} (invited ${when(i.created_at)})`,
                      h('button', { class: 'small', onclick: () => void act(() => api('DELETE', `/api/org/invites/${i.id}`), 'Invitation withdrawn.') }, 'Withdraw'),
                    ),
                  ),
                )
              : null,
            h('h2', {}, 'Seats'),
            h(
              'form',
              {
                class: 'row wrap',
                onsubmit: (e: Event) => {
                  e.preventDefault()
                  void act(() => api('POST', '/api/org/seats', { seats: Number(seats.value) }), 'Seats updated.')
                },
              },
              h('label', {}, 'Seats (at least 3, and no fewer than members)', seats),
              h('button', { type: 'submit' }, 'Change seats'),
            ),
            h('h2', {}, 'Close the studio'),
            h('p', { class: 'muted small' }, 'Closing cancels the subscription. Members keep their personal accounts and their own projects; shared projects return to the member who made them.'),
            h(
              'button',
              {
                class: 'danger',
                onclick: async () => {
                  if (await confirmDialog('Close the studio?', h('p', {}, `“${o.name}” will be closed and its subscription cancelled.`), 'Close studio'))
                    void act(() => api('POST', '/api/org/close'), 'The studio was closed.')
                },
              },
              'Close studio…',
            ),
          ]
        : h(
            'button',
            {
              class: 'danger',
              onclick: async () => {
                if (await confirmDialog('Leave the studio?', h('p', {}, 'You lose access to shared projects. Your private projects in the studio are offered to the owner.'), 'Leave'))
                  void act(() => api('POST', '/api/org/leave'), 'You left the studio.')
              },
            },
            'Leave studio',
          ),
    ),
  )
}
