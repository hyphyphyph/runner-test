// The shell: who the person is, the allowance that is always visible, the
// message area with its one retry, and the gate.

import { ApiError, api, onConnection } from './api.ts'
import { day, h, mount, plural } from './ui.ts'
import type { Allowance, Gate, Me } from '../shared/types.ts'

export const state: { me: Me | null } = { me: null }

const meListeners = new Set<() => void>()
export function onMe(fn: () => void): () => void {
  meListeners.add(fn)
  return () => meListeners.delete(fn)
}

export async function refreshMe(): Promise<Me> {
  state.me = await api<Me>('GET', '/api/me')
  renderAllowance()
  renderNav()
  for (const fn of meListeners) fn()
  return state.me
}

export function go(hash: string): void {
  location.hash = hash
}

// --- the always-visible allowance -----------------------------------------

function left(c: { used: number; limit: number }): number {
  return Math.max(0, c.limit - c.used)
}

export function allowanceText(a: Allowance): string {
  return `${left(a.rounds)} of ${a.rounds.limit} rounds, ${left(a.revisions)} of ${a.revisions.limit} revisions, ${left(a.checks)} of ${a.checks.limit} checks left`
}

function renderAllowance(): void {
  const el = document.getElementById('allowance')
  if (!el || !state.me) return
  const a = state.me.allowance
  const meter = (label: string, c: { used: number; limit: number }) =>
    h(
      'span',
      { class: 'meter' + (left(c) === 0 ? ' empty' : '') },
      h('span', { class: 'meter-label' }, label),
      h('meter', { min: 0, max: c.limit, value: left(c), 'aria-hidden': 'true' }),
      h('span', {}, `${left(c)}/${c.limit}`),
    )
  mount(
    el,
    h('span', { class: 'sr-only' }, allowanceText(a) + '.'),
    h(
      'span',
      { class: 'meters', 'aria-hidden': 'true' },
      meter('Rounds', a.rounds),
      meter('Revisions', a.revisions),
      meter('Checks', a.checks),
      a.credits > 0 || state.me.account ? h('span', { class: 'meter' }, h('span', { class: 'meter-label' }, 'Credits'), String(a.credits)) : null,
    ),
    h('span', { class: 'muted small' }, `${a.plan === 'free' ? 'Free allowance' : a.plan === 'pro' ? 'Pro' : 'Studio'} · refreshes ${day(a.resetsAt)}`),
  )
}

function renderNav(): void {
  const el = document.getElementById('nav')
  if (!el || !state.me) return
  const acc = state.me.account
  mount(
    el,
    h('a', { href: '#/' }, 'Projects'),
    h('a', { href: '#/plans' }, 'Plans'),
    acc?.org ? h('a', { href: '#/studio' }, 'Studio') : null,
    acc?.operator ? h('a', { href: '#/admin' }, 'Admin') : null,
    acc ? h('a', { href: '#/account' }, acc.email) : h('a', { href: '#/signin', class: 'button small' }, 'Sign in'),
  )
}

// --- messages with one retry ------------------------------------------------

let currentRetry: (() => void) | null = null

export function showProblem(e: unknown, retry?: () => void): void {
  if (e instanceof ApiError && e.gate) {
    void showGate(e.gate)
    return
  }
  const el = document.getElementById('problem')!
  const message = e instanceof Error ? e.message : String(e)
  const canRetry = !!retry && !(e instanceof ApiError && !e.retry)
  currentRetry = canRetry ? retry! : null
  mount(
    el,
    h(
      'div',
      { class: 'problem', role: 'alert' },
      h('p', {}, message),
      h(
        'div',
        { class: 'row' },
        canRetry
          ? h('button', {
              class: 'primary small',
              onclick: () => {
                const r = currentRetry
                clearProblem()
                r?.()
              },
            }, 'Try again')
          : null,
        h('button', { class: 'small', onclick: clearProblem }, 'Dismiss'),
      ),
    ),
  )
}

export function clearProblem(): void {
  currentRetry = null
  const el = document.getElementById('problem')
  if (el) el.replaceChildren()
}

export function notice(text: string): void {
  const el = document.getElementById('notice')!
  mount(el, h('div', { class: 'notice', role: 'status' }, text))
  setTimeout(() => {
    if (el.textContent === text) el.replaceChildren()
  }, 5000)
}

// --- the gate ---------------------------------------------------------------

export async function showGate(g: Gate): Promise<void> {
  const d = h('dialog', { class: 'dialog', 'aria-labelledby': 'gate-title' })
  const close = () => {
    d.close()
    d.remove()
  }
  const to = (hash: string) => () => {
    close()
    go(hash)
  }
  mount(
    d,
    h('h2', { id: 'gate-title' }, 'You have reached a limit'),
    h('p', {}, g.ranOut),
    g.resetsAt ? h('p', {}, `Your allowance comes back on ${day(g.resetsAt)}.`) : null,
    h('p', { class: 'muted' }, 'Everything already on screen stays: your names, notes and check results. You can still read, compare, copy and download them.'),
    h(
      'div',
      { class: 'stack' },
      !g.signedIn ? h('button', { class: 'primary', onclick: to('#/signin') }, 'Sign in to keep your work and use your account’s allowance') : null,
      h('button', { class: g.signedIn ? 'primary' : '', onclick: to('#/plans') }, 'Subscribe to raise the limit'),
      g.canBuyCredits
        ? h('button', { onclick: to('#/plans?credits=1') }, 'Buy credits to continue without a subscription')
        : !g.signedIn && !g.network
          ? h('p', { class: 'muted small' }, 'Credits can be bought once you are signed in.')
          : null,
      h('button', { onclick: close }, 'Not now'),
    ),
  )
  d.addEventListener('cancel', close)
  document.body.append(d)
  d.showModal()
}

// --- the frame ----------------------------------------------------------------

export function frame(root: HTMLElement): HTMLElement {
  const main = h('main', { id: 'view', tabindex: '-1' })
  mount(
    root,
    h('a', { href: '#view', class: 'skip' }, 'Skip to content'),
    h(
      'header',
      { class: 'top' },
      h('a', { href: '#/', class: 'brand' }, 'NameTempest'),
      h('div', { id: 'allowance', class: 'allowance', 'aria-live': 'polite' }),
      h('nav', { id: 'nav', 'aria-label': 'Main' }),
    ),
    h('div', { id: 'offline', class: 'offline', hidden: true, role: 'status' }, 'You are offline. This page may be out of date, and nothing is saved until the connection returns. Your work stays on screen.'),
    h('div', { id: 'problem' }),
    h('div', { id: 'notice' }),
    main,
    h(
      'footer',
      { class: 'foot muted small' },
      'NameTempest · nametempest.com · Names come from an AI model. A free .com today can be registered by someone else tomorrow; NameTempest never buys or reserves domains.',
    ),
  )
  onConnection((on) => {
    document.getElementById('offline')!.hidden = on
  })
  document.getElementById('offline')!.hidden = navigator.onLine
  return main
}

export function plainCount(n: number, word: string): string {
  return plural(n, word)
}
