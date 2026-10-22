// A small DOM builder. Text is always set as text, never parsed as HTML.

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: any) => void)>
export type Child = Node | string | number | null | undefined | false | Child[]

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v)
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, String(v))
  }
  append(el, children)
  return el
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)))
  }
}

export function mount(el: Element, ...children: Child[]): void {
  el.replaceChildren()
  append(el, children)
}

export function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function day(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'long' })
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return day(ts)
}

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`
}

// A modal dialog that resolves with the button the person chose.
export function dialog(title: string, body: Child, buttons: { label: string; value: string; primary?: boolean }[]): Promise<string | null> {
  return new Promise((resolve) => {
    const d = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' })
    const close = (v: string | null) => {
      d.close()
      d.remove()
      resolve(v)
    }
    d.append(
      h('h2', { id: 'dlg-title' }, title),
      h('div', { class: 'dialog-body' }, body),
      h(
        'div',
        { class: 'row end' },
        ...buttons.map((b) => h('button', { class: b.primary ? 'primary' : '', onclick: () => close(b.value) }, b.label)),
      ),
    )
    d.addEventListener('cancel', (e) => {
      e.preventDefault()
      close(null)
    })
    document.body.append(d)
    d.showModal()
  })
}

export async function confirmDialog(title: string, body: Child, yes: string): Promise<boolean> {
  return (await dialog(title, body, [{ label: 'Cancel', value: 'no' }, { label: yes, value: 'yes', primary: true }])) === 'yes'
}

export function download(name: string, url: string): void {
  const a = h('a', { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
}
