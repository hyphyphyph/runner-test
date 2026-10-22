// The operator's admin interface: limits, levels and models, style lists,
// lookup service, prices, people, seats, alerts and the change record.

import { api } from '../api.ts'
import { clearProblem, go, notice, refreshMe, showProblem, state } from '../app.ts'
import { dialog, h, mount, when } from '../ui.ts'
import type { Allowance, Level } from '../../shared/types.ts'

interface Overview {
  settings: { key: string; label: string; group: string; value: number; def: number; min: number }[]
  config: {
    levels: Record<Level, { label: string; model: string }>
    styleLists: { namingStyle: string[]; tone: string[] }
    paidLookup: null | { name: string; url: string }
    currency: string
  }
  parts: { part: string; unavailable: boolean }[]
  alerts: { id: number; part: string; began_at: number; last_at: number; failures: number; people: number; reason: string; dismissed_at: number | null }[]
  audit: { id: number; at: number; operator: string; action: string; target: string; old_value: string; new_value: string; reason: string }[]
  numbers: { payingPro: number; payingStudios: number; studioSeats: number; conversion: number; medianShortlist: number }
}

interface Person {
  id: string
  email: string
  plan: string
  planActive: boolean
  credits: number
  deletedAt: number | null
  org: null | { id: string; name: string; role: string; seats: number; credits: number; active: boolean }
  members: number
  allowance: Allowance
}

async function askReason(title: string, body: string): Promise<string | null> {
  const input = h('input', { type: 'text', required: true, maxlength: 500, 'aria-label': 'Reason' })
  const ok = await dialog(title, h('div', { class: 'stack' }, h('p', {}, body), h('label', {}, 'Reason (kept in the record)', input)), [
    { label: 'Cancel', value: 'no' },
    { label: 'Confirm and save', value: 'yes', primary: true },
  ])
  if (ok !== 'yes') return null
  if (!input.value.trim()) {
    showProblem(new Error('A reason is needed for every admin change.'))
    return null
  }
  return input.value.trim()
}

export async function adminView(main: HTMLElement): Promise<void> {
  if (!state.me?.account?.operator) {
    go('#/')
    return
  }
  let o: Overview
  try {
    o = await api<Overview>('GET', '/api/admin')
  } catch (e) {
    showProblem(e, () => void adminView(main))
    return
  }
  const reload = async (msg: string) => {
    clearProblem()
    notice(msg)
    await refreshMe()
    await adminView(main)
  }
  const post = async (path: string, body: Record<string, unknown>, msg: string) => {
    try {
      await api('POST', path, body)
      await reload(msg)
    } catch (e) {
      showProblem(e)
    }
  }

  // Limits and prices: one number each.
  const groups = new Map<string, Overview['settings']>()
  for (const s of o.settings) groups.set(s.group, [...(groups.get(s.group) ?? []), s])
  const settingRow = (s: Overview['settings'][number]) => {
    const input = h('input', { type: 'number', min: s.min, step: 1, value: s.value, 'aria-label': s.label })
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, s.label),
      h('td', {}, input),
      h('td', { class: 'muted small' }, `shipped: ${s.def}`),
      h(
        'td',
        {},
        h(
          'button',
          {
            class: 'small',
            onclick: async () => {
              const v = Number(input.value)
              if (!Number.isInteger(v) || v < 1) return showProblem(new Error(`${s.label} must be a positive whole number.`))
              if (v === s.value) return
              const reason = await askReason('Change a setting', `${s.label}: ${s.value} → ${v}. It applies from the next counted action; nothing already spent changes.`)
              if (reason) void post('/api/admin/setting', { key: s.key, value: v, reason }, 'Setting saved.')
            },
          },
          'Save',
        ),
        ' ',
        s.value !== s.def
          ? h(
              'button',
              {
                class: 'small',
                onclick: async () => {
                  const reason = await askReason('Clear a setting', `Clear ${s.label} back to the shipped value of ${s.def}.`)
                  if (reason) void post('/api/admin/setting', { key: s.key, clear: true, reason }, 'Setting cleared.')
                },
              },
              'Clear to shipped value',
            )
          : null,
      ),
    )
  }

  // Levels, models, pick lists, lookup service and currency.
  const cfg = structuredClone(o.config)
  const levelRows = (['quick', 'balanced', 'thorough'] as Level[]).map((l) => {
    const label = h('input', { type: 'text', value: cfg.levels[l].label, 'aria-label': `${l} name`, oninput: (e: Event) => (cfg.levels[l].label = (e.target as HTMLInputElement).value) })
    const model = h('input', { type: 'text', value: cfg.levels[l].model, 'aria-label': `${l} model`, oninput: (e: Event) => (cfg.levels[l].model = (e.target as HTMLInputElement).value) })
    const part = o.parts.find((p) => p.part === 'level:' + l)!
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, l),
      h('td', {}, label),
      h('td', {}, model),
      h('td', {}, part.unavailable ? h('span', { class: 'tag' }, 'unavailable') : 'available'),
    )
  })
  const listInput = (key: 'namingStyle' | 'tone') =>
    h('textarea', {
      rows: 3,
      value: cfg.styleLists[key].join(', '),
      oninput: (e: Event) =>
        (cfg.styleLists[key] = (e.target as HTMLTextAreaElement).value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)),
    })
  const paidUrl = h('input', { type: 'url', value: cfg.paidLookup?.url ?? '', placeholder: 'empty: the shipped free chain only' })
  const currency = h('input', { type: 'text', value: cfg.currency, maxlength: 3, size: 4 })
  const saveConfig = async () => {
    cfg.paidLookup = paidUrl.value.trim() ? { name: 'paid', url: paidUrl.value.trim() } : null
    cfg.currency = currency.value.trim().toLowerCase()
    const reason = await askReason('Save levels and lists', 'Level names, models, pick lists, the paid lookup service and the currency will be saved. A removed pick stays on projects that hold it.')
    if (reason) void post('/api/admin/config', { config: cfg, reason }, 'Configuration saved.')
  }

  // People.
  const q = h('input', { type: 'search', placeholder: 'Email address', 'aria-label': 'Search by email' })
  const results = h('div')
  const search = async () => {
    try {
      const people = await api<Person[]>('GET', `/api/admin/people?q=${encodeURIComponent(q.value)}`)
      mount(results, people.length ? people.map(personCard) : h('p', { class: 'muted' }, 'No account matches.'))
    } catch (e) {
      showProblem(e)
    }
  }
  const personCard = (p: Person) => {
    const a = p.allowance
    const credits = h('input', { type: 'number', min: 1, step: 1, value: 5, 'aria-label': 'Credits to grant' })
    const seats = h('input', { type: 'number', min: Math.max(3, p.members), step: 1, value: p.org?.seats ?? 3, 'aria-label': 'Seats' })
    return h(
      'article',
      { class: 'card' },
      h('h3', {}, p.email, p.deletedAt ? h('span', { class: 'tag' }, 'deletion pending') : null),
      h(
        'p',
        {},
        `Plan: ${p.plan}${p.planActive ? '' : ' (not active)'} · Credits: ${p.credits} · This month: ${a.rounds.limit - a.rounds.used}/${a.rounds.limit} rounds, ${a.revisions.limit - a.revisions.used}/${a.revisions.limit} revisions, ${a.checks.limit - a.checks.used}/${a.checks.limit} checks left`,
      ),
      p.org ? h('p', {}, `Organization: ${p.org.name} (${p.org.role}) · ${p.members} members · ${p.org.seats} seats · ${p.org.credits} studio credits`) : null,
      h(
        'div',
        { class: 'row wrap' },
        credits,
        h(
          'button',
          {
            class: 'small',
            onclick: async () => {
              const n = Number(credits.value)
              const reason = await askReason('Grant credits', `Add ${n} credits to ${p.email}. They are told by email.`)
              if (reason) void post('/api/admin/credits', { accountId: p.id, credits: n, reason }, 'Credits granted.').then(search)
            },
          },
          'Grant credits',
        ),
        h(
          'button',
          {
            class: 'small',
            onclick: async () => {
              const to = p.plan === 'pro' && p.planActive ? 'free' : 'pro'
              const reason = await askReason('Change plan', `Change ${p.email} to ${to}. This does not change their bill with the payment provider.`)
              if (reason) void post('/api/admin/plan', { accountId: p.id, plan: to, reason }, 'Plan changed.').then(search)
            },
          },
          p.plan === 'pro' && p.planActive ? 'Set to free' : 'Set to Pro',
        ),
        p.org && p.org.role !== 'owner'
          ? h(
              'button',
              {
                class: 'small danger',
                onclick: async () => {
                  const reason = await askReason('Remove from organization', `Remove ${p.email} from ${p.org!.name}.`)
                  if (reason) void post('/api/admin/remove-from-org', { accountId: p.id, reason }, 'Removed from the organization.').then(search)
                },
              },
              'Remove from organization',
            )
          : null,
        p.org
          ? [
              seats,
              h(
                'button',
                {
                  class: 'small',
                  onclick: async () => {
                    const n = Number(seats.value)
                    const reason = await askReason('Change seats', `Set ${p.org!.name} to ${n} seats (it has ${p.members} members).`)
                    if (reason) void post('/api/admin/seats', { orgId: p.org!.id, seats: n, reason }, 'Seats changed.').then(search)
                  },
                },
                'Set seats',
              ),
            ]
          : null,
      ),
    )
  }

  const alertRow = (a: Overview['alerts'][number]) =>
    h(
      'tr',
      { class: a.dismissed_at ? 'muted' : '' },
      h('td', {}, a.part),
      h('td', {}, a.reason),
      h('td', {}, String(a.failures)),
      h('td', {}, String(a.people)),
      h('td', {}, when(a.began_at)),
      h('td', {}, when(a.last_at)),
      h(
        'td',
        {},
        h(
          'button',
          {
            class: 'small',
            onclick: async () => {
              try {
                const rows = await api<{ at: number; action: string; reason: string; detail: string }[]>('GET', `/api/admin/alerts/${a.id}`)
                void dialog(
                  `Failures of ${a.part}`,
                  h('ul', { class: 'detail' }, rows.map((r) => h('li', {}, h('strong', {}, when(r.at)), ` ${r.action}: ${r.reason}`, h('pre', {}, r.detail)))),
                  [{ label: 'Close', value: 'x' }],
                )
              } catch (e) {
                showProblem(e)
              }
            },
          },
          'Detail',
        ),
        ' ',
        !a.dismissed_at ? h('button', { class: 'small', onclick: () => void post(`/api/admin/alerts/${a.id}/dismiss`, {}, 'Alert dismissed.') }, 'Dismiss') : null,
      ),
    )

  const n = o.numbers
  mount(
    main,
    h('h1', {}, 'Admin'),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Alerts'),
      o.alerts.length
        ? h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['Part', 'Reason', 'Failures', 'People', 'Began', 'Last', ''].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', {}, o.alerts.map(alertRow)),
          )
        : h('p', { class: 'muted' }, 'No alerts.'),
      h('h3', {}, 'Parts'),
      h(
        'ul',
        {},
        o.parts.map((p) =>
          h(
            'li',
            { class: 'row' },
            `${p.part}: ${p.unavailable ? 'marked unavailable' : 'available'}`,
            h(
              'button',
              {
                class: 'small',
                onclick: async () => {
                  const reason = await askReason(
                    p.unavailable ? 'Mark available' : 'Mark unavailable',
                    p.unavailable ? `${p.part} will be offered again.` : `People will see a plain message instead of a failing ${p.part}.`,
                  )
                  if (reason) void post('/api/admin/part', { part: p.part, unavailable: !p.unavailable, reason }, 'Saved.')
                },
              },
              p.unavailable ? 'Mark available' : 'Mark unavailable',
            ),
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'First-month numbers'),
      h(
        'dl',
        { class: 'facts' },
        h('dt', {}, 'Paying Pro accounts'),
        h('dd', {}, String(n.payingPro)),
        h('dt', {}, 'Paying studios'),
        h('dd', {}, `${n.payingStudios} (${n.studioSeats} seats)`),
        h('dt', {}, 'Free-to-paid conversion'),
        h('dd', {}, `${n.conversion}%`),
        h('dt', {}, 'Typical shortlist'),
        h('dd', {}, `${n.medianShortlist} names`),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Limits and prices'),
      [...groups].map(([g, list]) => [h('h3', {}, g), h('table', { class: 'settings' }, h('tbody', {}, list.map(settingRow)))]),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Effort levels, style lists and lookup'),
      h('p', { class: 'muted small' }, 'There are exactly three levels. Use the model name "demo" for the built-in generator.'),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ['Level', 'Name shown', 'Model', 'Status'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, levelRows),
      ),
      h('label', {}, 'Naming style choices (comma separated)', listInput('namingStyle')),
      h('label', {}, 'Tone choices (comma separated)', listInput('tone')),
      h('label', {}, 'Paid lookup service (https address; optional)', paidUrl),
      h('label', {}, 'Currency', currency),
      h('button', { class: 'primary', onclick: () => void saveConfig() }, 'Save…'),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'People'),
      h(
        'form',
        {
          class: 'row',
          onsubmit: (e: Event) => {
            e.preventDefault()
            void search()
          },
        },
        q,
        h('button', { type: 'submit' }, 'Search'),
      ),
      results,
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Change record'),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ['When', 'Operator', 'Change', 'Target', 'Old', 'New', 'Reason'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          {},
          o.audit.map((r) =>
            h(
              'tr',
              {},
              [when(r.at), r.operator, r.action, r.target, r.old_value, r.new_value, r.reason].map((v) =>
                h('td', { class: 'small' }, v && v.length > 80 ? v.slice(0, 80) + '…' : (v ?? '')),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}
