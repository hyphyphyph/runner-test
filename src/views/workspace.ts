// The naming workspace: the project list, the company brief and style form,
// rounds and revisions with their cost shown first, the candidate list with
// domain checks, notes, comparison and export.

import { ApiError, api } from '../api.ts'
import { clearProblem, go, notice, refreshMe, showProblem, state } from '../app.ts'
import { ago, confirmDialog, dialog, download, h, mount, plural, when } from '../ui.ts'
import { shortlist, toText } from '../../shared/export.ts'
import type { Candidate, Level, LevelInfo, Note, Project, ProjectDetail, Style } from '../../shared/types.ts'

type Filter = 'play' | 'shortlist' | 'rejected' | 'all'

interface RoundState {
  id: string
  kind: 'generate' | 'revise'
  state: 'starting' | 'queued' | 'running'
  place: number
  count: number
  startedAt: number
  expected: number
}

const ws = {
  projects: [] as Project[],
  current: null as ProjectDetail | null,
  es: null as EventSource | null,
  live: 'connecting' as 'connecting' | 'live' | 'stale',
  filter: 'play' as Filter,
  selected: new Set<string>(),
  checking: new Set<string>(),
  level: 'balanced' as Level,
  reviseLevel: 'balanced' as Level,
  round: null as RoundState | null,
  lastRound: 0,
  briefDirty: false,
  revise: { direction: '', avoid: '' },
  noteFor: null as string | null,
  noteDraft: '',
  tick: 0 as unknown as ReturnType<typeof setInterval> | 0,
  pendingNotes: false,
}

let root: HTMLElement
const sections = {
  side: h('aside', { class: 'side', 'aria-label': 'Projects' }),
  head: h('div'),
  banners: h('div'),
  brief: h('section', { class: 'card', 'aria-labelledby': 'brief-h' }),
  generate: h('section', { class: 'card', 'aria-labelledby': 'gen-h' }),
  list: h('section', { class: 'card', 'aria-labelledby': 'list-h' }),
  revise: h('section', { class: 'card', 'aria-labelledby': 'rev-h' }),
  notes: h('section', { class: 'card', 'aria-labelledby': 'notes-h' }),
}

export async function workspaceView(main: HTMLElement, projectId: string | null): Promise<void> {
  root = main
  const content = h('div', { class: 'content' }, sections.head, sections.banners, sections.brief, sections.generate, sections.list, sections.revise, sections.notes)
  mount(main, h('div', { class: 'workspace' }, sections.side, content))
  try {
    ws.projects = await api<Project[]>('GET', '/api/projects')
  } catch (e) {
    showProblem(e, () => void workspaceView(main, projectId))
    return
  }
  const target = projectId ?? ws.projects[0]?.id ?? null
  renderSide()
  if (!target) {
    closeLive()
    ws.current = null
    renderWelcome()
    return
  }
  await openProject(target)
}

function renderWelcome(): void {
  for (const s of [sections.banners, sections.generate, sections.list, sections.revise, sections.notes]) s.replaceChildren()
  mount(sections.head, h('h1', {}, 'Find a company name'))
  mount(
    sections.brief,
    h('h2', { id: 'brief-h' }, 'How it works'),
    h(
      'ol',
      { class: 'steps' },
      h('li', {}, 'Describe the company in your own words. Pick a style if you like; every field is optional.'),
      h('li', {}, 'Generate a round of names. Each comes with one sentence on why it fits.'),
      h('li', {}, 'Keep the names you like, reject the rest, and revise the list with a direction.'),
      h('li', {}, 'Check which names have a free .com domain, then copy or download your shortlist.'),
    ),
    h('p', { class: 'muted' }, 'No account is needed. The free allowance covers a whole naming job each month.'),
    h('button', { class: 'primary', onclick: () => void newProject() }, 'Start a naming project'),
  )
}

// --- projects -------------------------------------------------------------------

function renderSide(): void {
  mount(
    sections.side,
    h('h2', { class: 'small-h' }, 'Projects'),
    h(
      'ul',
      { class: 'projects' },
      ws.projects.map((p) =>
        h(
          'li',
          {},
          h(
            'a',
            { href: `#/p/${p.id}`, 'aria-current': ws.current?.id === p.id ? 'page' : null },
            p.name,
            p.shared ? h('span', { class: 'tag' }, 'shared') : null,
          ),
        ),
      ),
    ),
    h('button', { class: 'small', onclick: () => void newProject() }, '+ New project'),
    h(
      'p',
      { class: 'muted small' },
      h('a', { href: '/api/export?format=csv', download: true }, 'Download every project (CSV)'),
    ),
  )
}

async function newProject(): Promise<void> {
  try {
    const p = await api<ProjectDetail>('POST', '/api/projects', { name: `Project ${ws.projects.length + 1}` })
    clearProblem()
    go(`#/p/${p.id}`)
  } catch (e) {
    showProblem(e, () => void newProject())
  }
}

async function openProject(id: string): Promise<void> {
  try {
    ws.current = await api<ProjectDetail>('GET', `/api/projects/${id}`)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      notice('That project is no longer available.')
      go('#/')
      return
    }
    showProblem(e, () => void openProject(id))
    return
  }
  ws.selected.clear()
  ws.checking.clear()
  ws.briefDirty = false
  ws.lastRound = ws.current.rounds
  ws.noteFor = null
  ws.noteDraft = ''
  renderSide()
  renderAll()
  openLive(id)
}

function renderAll(): void {
  renderHead()
  renderBanners()
  renderBrief()
  renderGenerate()
  renderList()
  renderRevise()
  renderNotes()
}

// --- live updates -------------------------------------------------------------------

function closeLive(): void {
  ws.es?.close()
  ws.es = null
}

function openLive(id: string): void {
  closeLive()
  ws.live = 'connecting'
  const es = new EventSource(`/api/projects/${id}/events`)
  ws.es = es
  let hadError = false
  es.onopen = () => {
    ws.live = 'live'
    renderHead()
    // Catch up on whatever changed while the connection was down.
    if (hadError) void reloadCurrent()
    hadError = false
  }
  es.onerror = () => {
    hadError = true
    ws.live = 'stale'
    renderHead()
  }
  es.onmessage = (m) => {
    if (!ws.current || ws.current.id !== id) return
    const ev = JSON.parse(m.data)
    applyEvent(ev)
  }
}

function applyEvent(ev: any): void {
  const p = ws.current!
  switch (ev.type) {
    case 'candidate': {
      const c = ev.candidate as Candidate
      const i = p.candidates.findIndex((x) => x.id === c.id)
      if (i >= 0) p.candidates[i] = c
      else p.candidates.push(c)
      if (c.checkedAt) ws.checking.delete(c.id)
      renderList()
      break
    }
    case 'note': {
      const n = ev.note as Note
      const i = p.notes.findIndex((x) => x.id === n.id)
      if (i >= 0) p.notes[i] = n
      else p.notes.push(n)
      renderNotesSafely()
      break
    }
    case 'note-deleted':
      p.notes = p.notes.filter((n) => n.id !== ev.noteId)
      renderNotesSafely()
      break
    case 'project':
      Object.assign(p, ev.project)
      renderHead()
      renderBanners()
      if (!ws.briefDirty) renderBrief()
      renderList()
      break
    case 'round':
      if (ws.round && ev.roundId === ws.round.id) {
        if (ev.state === 'queued') Object.assign(ws.round, { state: 'queued', place: ev.place })
        if (ev.state === 'running') ws.round.state = 'running'
        if (ev.state === 'names') ws.round.count = ev.count
        renderGenerate()
      } else if (ev.state === 'running' && ev.by) {
        notice(`${ev.by} started a round on this project.`)
      }
      break
    case 'deleted':
      notice('This project was deleted.')
      closeLive()
      go('#/')
      break
    case 'refresh':
      void reloadCurrent()
      break
  }
}

async function reloadCurrent(): Promise<void> {
  if (!ws.current) return
  try {
    const fresh = await api<ProjectDetail>('GET', `/api/projects/${ws.current.id}`)
    ws.current = fresh
    if (ws.live === 'stale') ws.live = 'live'
    renderHead()
    renderBanners()
    if (!ws.briefDirty) renderBrief()
    renderList()
    renderNotesSafely()
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      notice('You no longer have access to this project.')
      go('#/')
    }
  }
}

// --- header -------------------------------------------------------------------------

function renderHead(): void {
  const p = ws.current
  if (!p) return
  const rename = async () => {
    const input = h('input', { type: 'text', value: p.name, maxlength: 120, 'aria-label': 'Project name' })
    const ok = await dialog('Rename project', h('label', {}, 'Project name', input), [
      { label: 'Cancel', value: 'no' },
      { label: 'Rename', value: 'yes', primary: true },
    ])
    if (ok !== 'yes') return
    const doIt = async () => {
      try {
        const next = await api<ProjectDetail>('PATCH', `/api/projects/${p.id}`, { name: input.value })
        p.name = next.name
        clearProblem()
        ws.projects = ws.projects.map((x) => (x.id === p.id ? { ...x, name: next.name } : x))
        renderSide()
        renderHead()
      } catch (e) {
        showProblem(e, () => void doIt())
      }
    }
    await doIt()
  }
  const share = async () => {
    const doIt = async () => {
      try {
        Object.assign(p, await api<ProjectDetail>('PATCH', `/api/projects/${p.id}`, { shared: !p.shared }))
        clearProblem()
        notice(p.shared ? 'This project is now shared with your studio.' : 'This project is private again.')
        renderHead()
      } catch (e) {
        showProblem(e, () => void doIt())
      }
    }
    await doIt()
  }
  const del = async () => {
    const ok = await confirmDialog(
      'Delete this project?',
      h('p', {}, `“${p.name}” and its description, ${plural(p.candidates.length, 'name')}, notes and usage record will be removed at once${p.shared ? ', for every member of your studio' : ''}. This cannot be undone.`),
      'Delete project',
    )
    if (!ok) return
    try {
      await api('DELETE', `/api/projects/${p.id}`)
      clearProblem()
      closeLive()
      ws.current = null
      notice('Project deleted.')
      go('#/')
      void workspaceView(root, null)
    } catch (e) {
      showProblem(e, () => void del())
    }
  }
  const liveLabel =
    ws.live === 'stale'
      ? h('span', { class: 'status warn', role: 'status' }, '⚠ Out of date: reconnecting. Changes are not saved until the connection returns.')
      : p.shared
        ? h('span', { class: 'status ok' }, ws.live === 'live' ? '● Live with your studio' : 'Connecting…')
        : null
  mount(
    sections.head,
    h(
      'div',
      { class: 'row between wrap' },
      h('h1', {}, p.name),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'small', onclick: rename }, 'Rename'),
        p.canShare || p.shared ? h('button', { class: 'small', onclick: share }, p.shared ? 'Make private' : 'Share with studio') : null,
        h('button', { class: 'small danger', onclick: del }, 'Delete'),
      ),
    ),
    h(
      'p',
      { class: 'muted small' },
      p.shared && p.ownerLabel ? `Shared by ${p.ownerLabel} · ` : '',
      `Spent on this project: ${plural(p.usage.rounds, 'round')}, ${plural(p.usage.revisions, 'revision')}, ${plural(p.usage.checks, 'check')}${p.usage.credits ? `, ${plural(p.usage.credits, 'credit')}` : ''}. `,
      liveLabel,
    ),
  )
}

function renderBanners(): void {
  const p = ws.current!
  const items = []
  if (p.conflictWith) {
    const resolve = async (keep: 'this' | 'other' | 'both') => {
      try {
        await api('POST', `/api/projects/${p.id}/resolve`, { keep })
        clearProblem()
        void workspaceView(root, keep === 'other' ? p.conflictWith : p.id)
      } catch (e) {
        showProblem(e, () => void resolve(keep))
      }
    }
    items.push(
      h(
        'div',
        { class: 'banner' },
        h('p', {}, 'Your account already had a project with this name. Both copies are kept until you choose.'),
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'small', onclick: () => void resolve('this') }, 'Keep this copy'),
          h('button', { class: 'small', onclick: () => void resolve('other') }, 'Keep the account’s copy'),
          h('button', { class: 'small', onclick: () => void resolve('both') }, 'Keep both'),
          h('a', { href: `#/p/${p.conflictWith}` }, 'See the other copy'),
        ),
      ),
    )
  }
  if (p.offeredFrom) {
    const decide = async (keep: boolean) => {
      try {
        await api('POST', `/api/projects/${p.id}/offer`, { keep })
        clearProblem()
        void workspaceView(root, keep ? p.id : null)
      } catch (e) {
        showProblem(e, () => void decide(keep))
      }
    }
    items.push(
      h(
        'div',
        { class: 'banner' },
        h('p', {}, `${p.offeredFrom} is no longer in your studio. This was their private project, and it is offered to you.`),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'small', onclick: () => void decide(true) }, 'Keep it'),
          h('button', { class: 'small danger', onclick: () => void decide(false) }, 'Delete it'),
        ),
      ),
    )
  }
  mount(sections.banners, items)
}

// --- the brief and the style form ------------------------------------------------------

function styleSummary(s: Style): string {
  const parts = [
    s.namingStyle,
    s.tone,
    s.length === 'one' ? 'one word' : s.length === 'two' ? 'two words' : '',
    s.include && `include: ${s.include}`,
    s.avoid && `avoid: ${s.avoid}`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No style chosen: names follow the description alone'
}

let briefFields: () => { description: string; industry: string; style: Style } = () => ({
  description: '',
  industry: '',
  style: { namingStyle: '', tone: '', length: '', include: '', avoid: '' },
})

function renderBrief(): void {
  const p = ws.current!
  const lists = state.me!.styleLists
  const select = (label: string, list: string[], value: string, help: string) => {
    const options = [...list]
    if (value && !options.includes(value)) options.push(value)
    return h(
      'label',
      {},
      label,
      h(
        'select',
        { onchange: dirty },
        h('option', { value: '' }, 'No preference'),
        options.map((o) => h('option', { value: o, selected: o === value }, list.includes(o) ? o : `${o} (no longer offered)`)),
      ),
      h('span', { class: 'help' }, help),
    )
  }
  const desc = h('textarea', {
    rows: 5,
    maxlength: 5000,
    required: true,
    placeholder: 'What does the company do, for whom, and what makes it different?',
    oninput: dirty,
  })
  desc.value = p.description
  const industry = h('input', { type: 'text', value: p.industry, maxlength: 200, oninput: dirty, placeholder: 'For example: coffee, legal tech, garden design' })
  const naming = select('Naming style', lists.namingStyle, p.style.namingStyle, 'How the name is built')
  const tone = select('Tone', lists.tone, p.style.tone, 'How the name should feel')
  const lengthGroup = h(
    'fieldset',
    { class: 'inline' },
    h('legend', {}, 'Length'),
    ...(
      [
        ['', 'No preference'],
        ['one', 'One word'],
        ['two', 'Two words'],
      ] as const
    ).map(([v, l]) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'length', value: v, checked: p.style.length === v, onchange: dirty }), l)),
  )
  const include = h('input', { type: 'text', value: p.style.include, maxlength: 300, oninput: dirty, placeholder: 'Words or sounds to include' })
  const avoid = h('input', { type: 'text', value: p.style.avoid, maxlength: 300, oninput: dirty, placeholder: 'Words, sounds or competitor names to avoid' })
  const status = h('span', { class: 'muted small', role: 'status' }, '')
  briefFields = () => ({
    description: desc.value,
    industry: industry.value,
    style: {
      namingStyle: naming.querySelector('select')!.value,
      tone: tone.querySelector('select')!.value,
      length: (lengthGroup.querySelector('input:checked') as HTMLInputElement | null)?.value as Style['length'],
      include: include.value,
      avoid: avoid.value,
    },
  })
  function dirty() {
    ws.briefDirty = true
    status.textContent = 'Unsaved changes'
  }
  const save = async () => {
    if (await saveBrief()) status.textContent = 'Saved'
    else status.textContent = 'Not saved'
  }
  mount(
    sections.brief,
    h('h2', { id: 'brief-h' }, 'The company'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: Event) => {
          e.preventDefault()
          void save()
        },
      },
      h('label', {}, 'Describe the company in your own words', desc),
      h('label', {}, 'Industry or category (optional)', industry),
      h(
        'details',
        { open: Boolean(styleSummary(p.style) && (p.style.namingStyle || p.style.tone || p.style.length || p.style.include || p.style.avoid)) },
        h('summary', {}, 'Style (optional)'),
        h('div', { class: 'grid2' }, naming, tone, lengthGroup, h('label', {}, 'Things to include', include), h('label', {}, 'Things to avoid', avoid)),
        h('p', { class: 'muted small' }, 'A change of style applies to the next round. Names already in the list stay as they are.'),
      ),
      h('div', { class: 'row' }, h('button', { type: 'submit' }, 'Save'), status),
    ),
  )
}

async function saveBrief(): Promise<boolean> {
  const p = ws.current!
  if (!ws.briefDirty) return true
  try {
    const next = await api<ProjectDetail>('PATCH', `/api/projects/${p.id}`, briefFields())
    Object.assign(p, { description: next.description, industry: next.industry, style: next.style })
    ws.briefDirty = false
    clearProblem()
    renderList()
    return true
  } catch (e) {
    showProblem(e, () => void saveBrief())
    return false
  }
}

// --- generation -------------------------------------------------------------------------

function levelCost(l: LevelInfo, kind: 'generate' | 'revise'): { text: string; affordable: boolean } {
  const a = state.me!.allowance
  if (kind === 'revise') {
    const left = a.revisions.limit - a.revisions.used
    return left >= 1
      ? { text: `Spends 1 of your ${left} revision rounds left`, affordable: true }
      : { text: 'No revision rounds left this month', affordable: false }
  }
  const left = a.rounds.limit - a.rounds.used
  if (left >= l.multiplier) {
    return { text: `Spends ${plural(l.multiplier, 'round')} of your ${left} left, leaving ${left - l.multiplier}`, affordable: true }
  }
  if (a.credits >= l.creditCost) {
    return { text: `Spends ${plural(l.creditCost, 'credit')} of your ${a.credits}, leaving ${a.credits - l.creditCost}`, affordable: true }
  }
  return { text: `Needs ${plural(l.multiplier, 'round')}; you have ${left} left`, affordable: false }
}

function levelPicker(name: string, kind: 'generate' | 'revise', value: Level, onPick: (l: Level) => void) {
  const levels = state.me!.levels
  return h(
    'fieldset',
    { class: 'levels' },
    h('legend', {}, 'Effort level'),
    levels.map((l) => {
      const cost = levelCost(l, kind)
      const disabled = !l.available || !cost.affordable
      return h(
        'label',
        { class: 'level' + (disabled ? ' disabled' : '') },
        h('input', { type: 'radio', name, value: l.level, checked: l.level === value, disabled, onchange: () => onPick(l.level) }),
        h(
          'span',
          {},
          h('strong', {}, l.label),
          ' — ',
          l.level === 'quick' ? 'a fast, broad set' : l.level === 'balanced' ? 'the default' : 'fewer names, more reasoning',
          h('br'),
          h(
            'span',
            { class: 'muted small' },
            !l.available
              ? l.unavailableReason
              : kind === 'generate'
                ? `${l.batch} names · about ${l.expectedSeconds} seconds · ${cost.text}`
                : `${cost.text} · about ${l.expectedSeconds} seconds`,
          ),
        ),
      )
    }),
  )
}

function renderGenerate(): void {
  const p = ws.current
  if (!p || !state.me) return
  const r = ws.round
  if (r && r.kind === 'generate') {
    mount(sections.generate, h('h2', { id: 'gen-h' }, 'Generate names'), progress(r))
    return
  }
  const levels = state.me.levels
  const chosen = levels.find((l) => l.level === ws.level)
  if (chosen && (!chosen.available || !levelCost(chosen, 'generate').affordable)) {
    const ok = levels.find((l) => l.available && levelCost(l, 'generate').affordable)
    if (ok) ws.level = ok.level
  }
  mount(
    sections.generate,
    h('h2', { id: 'gen-h' }, 'Generate names'),
    levelPicker('level', 'generate', ws.level, (l) => {
      ws.level = l
    }),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', disabled: !!ws.round, onclick: () => void startRound('generate') }, p.rounds ? 'Generate another round' : 'Generate names'),
      p.description.trim() || ws.briefDirty ? null : h('span', { class: 'muted small' }, 'Describe the company above first.'),
    ),
  )
}

function progress(r: RoundState) {
  const secs = Math.round((Date.now() - r.startedAt) / 1000)
  const late = secs > r.expected
  return h(
    'div',
    { class: 'progress', role: 'status', 'aria-live': 'polite' },
    h(
      'p',
      {},
      r.state === 'queued'
        ? `Many people are naming right now. You are number ${r.place} in the queue; your round starts as soon as a place is free.`
        : r.count
          ? `Writing names… ${plural(r.count, 'name')} so far.`
          : 'Writing names…',
    ),
    h('progress', r.state === 'queued' ? {} : { max: r.expected, value: Math.min(secs, r.expected) }),
    h(
      'p',
      { class: 'muted small' },
      `${secs} seconds; expected about ${r.expected}. `,
      late ? 'This is taking longer than expected. You can keep waiting, or cancel; a cancelled round spends nothing.' : '',
    ),
    h('button', { onclick: () => void cancelRound() }, 'Cancel round'),
  )
}

function newRoundId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

async function startRound(kind: 'generate' | 'revise'): Promise<void> {
  const p = ws.current!
  if (!(await saveBrief())) return
  const level = kind === 'generate' ? ws.level : ws.reviseLevel
  const info = state.me!.levels.find((l) => l.level === level)!
  ws.round = { id: newRoundId(), kind, state: 'starting', place: 0, count: 0, startedAt: Date.now(), expected: info.expectedSeconds }
  ws.lastRound = p.rounds + 1
  const rerender = () => (kind === 'generate' ? renderGenerate() : renderRevise())
  rerender()
  ws.tick = setInterval(rerender, 1000)
  try {
    const body =
      kind === 'generate'
        ? { level, roundId: ws.round.id }
        : {
            level,
            roundId: ws.round.id,
            direction: ws.revise.direction,
            avoid: ws.revise.avoid,
            buildOn: [...ws.selected].filter((id) => p.candidates.some((c) => c.id === id && c.status !== 'rejected')),
          }
    const res = await api<{ added: Candidate[]; cancelled: boolean; dropped: string[] }>(
      'POST',
      `/api/projects/${p.id}/${kind === 'generate' ? 'rounds' : 'revisions'}`,
      body,
    )
    clearProblem()
    if (res.cancelled) notice(res.added.length ? `Round cancelled. ${plural(res.added.length, 'name')} that arrived stay; nothing was spent.` : 'Round cancelled. Nothing was spent.')
    else if (kind === 'revise') {
      notice(`Revision done: ${plural(res.added.length, 'new name')}${res.dropped.length ? `, ${res.dropped.length} removed` : ''}.`)
      ws.revise = { direction: '', avoid: '' }
      ws.selected.clear()
      ws.filter = 'play'
    } else notice(`${plural(res.added.length, 'new name')} added.`)
  } catch (e) {
    ws.lastRound = p.rounds
    showProblem(e, () => void startRound(kind))
  } finally {
    clearInterval(ws.tick as ReturnType<typeof setInterval>)
    ws.round = null
    await refreshMe().catch(() => undefined)
    await reloadCurrent()
    renderGenerate()
    renderRevise()
  }
}

async function cancelRound(): Promise<void> {
  if (!ws.round) return
  try {
    await api('POST', `/api/rounds/${ws.round.id}/cancel`)
  } catch (e) {
    showProblem(e, () => void cancelRound())
  }
}

// --- the candidate list ----------------------------------------------------------------------

const STATUS_TEXT: Record<Candidate['domainStatus'], string> = {
  unchecked: '○ Not checked',
  available: '✓ .com available',
  taken: '✕ .com taken',
  unknown: '? Not known right now',
  'not valid': '— Not a valid domain',
}

function isStale(c: Candidate): boolean {
  return !!c.checkedAt && (c.domainStatus === 'available' || c.domainStatus === 'taken') && Date.now() - c.checkedAt > state.me!.freshnessMinutes * 60_000
}

function domainCell(c: Candidate) {
  if (ws.checking.has(c.id)) return h('span', { class: 'dom checking' }, '… Checking')
  const stale = isStale(c)
  return h(
    'div',
    { class: `dom ${c.domainStatus.replace(' ', '-')}` },
    h('span', { class: 'dom-status' }, STATUS_TEXT[c.domainStatus]),
    c.domain && c.domainStatus !== 'not valid' ? h('span', { class: 'muted small mono' }, c.domain) : null,
    c.checkedAt && c.domainStatus !== 'not valid'
      ? h('span', { class: 'muted small', title: when(c.checkedAt) }, `checked ${ago(c.checkedAt)}`)
      : null,
    stale ? h('span', { class: 'stale small' }, 'Stale: check again before relying on it') : null,
    c.domainReason ? h('span', { class: 'small reason' }, c.domainReason) : null,
  )
}

function visible(p: ProjectDetail): Candidate[] {
  const cs = p.candidates.filter((c) => c.status !== 'dropped')
  switch (ws.filter) {
    case 'play':
      return cs.filter((c) => c.status === 'candidate' || c.status === 'kept')
    case 'shortlist':
      return cs.filter((c) => c.status === 'kept')
    case 'rejected':
      return cs.filter((c) => c.status === 'rejected')
    default:
      return cs
  }
}

async function setStatus(c: Candidate, status: Candidate['status']): Promise<void> {
  const p = ws.current!
  try {
    const next = await api<Candidate>('POST', `/api/projects/${p.id}/candidates/${c.id}`, { status })
    Object.assign(c, next)
    clearProblem()
    renderList()
  } catch (e) {
    showProblem(e, () => void setStatus(c, status))
  }
}

async function checkDomains(ids: string[]): Promise<void> {
  const p = ws.current!
  if (!ids.length) return
  for (const id of ids) ws.checking.add(id)
  renderList()
  try {
    const res = await api<{ results: Candidate[]; spent: number }>('POST', `/api/projects/${p.id}/check`, { ids })
    for (const r of res.results) {
      const c = p.candidates.find((x) => x.id === r.id)
      if (c) Object.assign(c, r)
    }
    clearProblem()
    const unknown = res.results.filter((r) => r.domainStatus === 'unknown').length
    notice(
      `Checked ${plural(res.results.length, 'name')}; ${plural(res.spent, 'check')} spent.` +
        (unknown ? ` ${unknown} could not be answered right now and spent nothing.` : ''),
    )
  } catch (e) {
    showProblem(e, () => void checkDomains(ids))
  } finally {
    for (const id of ids) ws.checking.delete(id)
    renderList()
    void refreshMe().catch(() => undefined)
  }
}

function compare(): void {
  const p = ws.current!
  const picked = p.candidates.filter((c) => ws.selected.has(c.id))
  void dialog(
    'Compare names',
    h(
      'div',
      { class: 'compare' },
      picked.map((c) =>
        h(
          'article',
          { class: 'cmp' },
          h('h3', {}, c.name),
          h('p', {}, c.reason),
          h('p', { class: 'small' }, h('span', { class: 'tag' }, c.style), ' ', c.status === 'kept' ? '★ in shortlist' : ''),
          domainCell(c),
          p.notes
            .filter((n) => n.candidateId === c.id)
            .map((n) => h('p', { class: 'small note-text' }, n.body)),
        ),
      ),
    ),
    [{ label: 'Close', value: 'close', primary: true }],
  )
}

async function copyShortlist(): Promise<void> {
  const list = shortlist(ws.current!.candidates)
  const text = toText(list)
  try {
    await navigator.clipboard.writeText(text)
    notice(`Copied ${plural(list.length, 'name')} to the clipboard.`)
  } catch {
    void dialog('Copy your shortlist', h('textarea', { rows: 10, readonly: true, value: text, 'aria-label': 'Shortlist' }), [{ label: 'Close', value: 'x' }])
  }
}

function renderList(): void {
  const p = ws.current
  if (!p || !state.me) return
  const cs = visible(p)
  const counts = {
    play: p.candidates.filter((c) => c.status === 'candidate' || c.status === 'kept').length,
    shortlist: p.candidates.filter((c) => c.status === 'kept').length,
    rejected: p.candidates.filter((c) => c.status === 'rejected').length,
    all: p.candidates.filter((c) => c.status !== 'dropped').length,
  }
  const tab = (f: Filter, label: string) =>
    h('button', { class: 'tab', 'aria-pressed': String(ws.filter === f), onclick: () => ((ws.filter = f), renderList()) }, `${label} (${counts[f]})`)
  const shortlistIds = shortlist(p.candidates).map((c) => c.id)
  const a = state.me.allowance
  const checksLeft = a.checks.limit - a.checks.used
  const selected = [...ws.selected].filter((id) => p.candidates.some((c) => c.id === id))
  const showNew = p.rounds > 1 && p.candidates.some((c) => c.round === p.rounds)
  const row = (c: Candidate) =>
    h(
      'li',
      { class: `cand ${c.status}` },
      h('input', {
        type: 'checkbox',
        'aria-label': `Select ${c.name}`,
        checked: ws.selected.has(c.id),
        onchange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) ws.selected.add(c.id)
          else ws.selected.delete(c.id)
          renderList()
        },
      }),
      h(
        'div',
        { class: 'cand-main' },
        h(
          'div',
          { class: 'row wrap' },
          h('strong', { class: 'cand-name' }, c.name),
          h('span', { class: 'tag' }, c.style),
          c.status === 'kept' ? h('span', { class: 'tag kept' }, '★ shortlist') : null,
          c.status === 'rejected' ? h('span', { class: 'tag' }, 'rejected') : null,
          showNew ? h('span', { class: 'tag ' + (c.round === p.rounds ? 'new' : '') }, c.round === p.rounds ? 'new' : 'unchanged') : null,
        ),
        h('p', { class: 'reason' }, c.reason),
        p.shared && (c.addedBy || c.changedBy)
          ? h(
              'p',
              { class: 'muted small' },
              c.addedBy ? `Added by ${c.addedBy}` : '',
              c.changedBy && c.status !== 'candidate' ? ` · ${c.status === 'rejected' ? 'rejected' : c.status === 'kept' ? 'kept' : 'changed'} by ${c.changedBy}` : '',
            )
          : null,
      ),
      domainCell(c),
      h(
        'div',
        { class: 'cand-actions' },
        c.status === 'kept'
          ? h('button', { class: 'small', onclick: () => void setStatus(c, 'candidate') }, 'Remove from shortlist')
          : c.status === 'candidate'
            ? h('button', { class: 'small', onclick: () => void setStatus(c, 'kept') }, '★ Keep')
            : null,
        c.status === 'rejected'
          ? h('button', { class: 'small', onclick: () => void setStatus(c, 'candidate') }, 'Restore')
          : h('button', { class: 'small', onclick: () => void setStatus(c, 'rejected') }, 'Reject'),
        c.status !== 'rejected'
          ? h('button', { class: 'small', disabled: ws.checking.has(c.id), onclick: () => void checkDomains([c.id]) }, c.domainStatus === 'unchecked' ? 'Check .com' : 'Check again')
          : null,
        h(
          'button',
          {
            class: 'small',
            onclick: () => {
              ws.noteFor = c.id
              renderNotes()
              sections.notes.querySelector('textarea')?.focus()
            },
          },
          'Note',
        ),
      ),
    )
  mount(
    sections.list,
    h('h2', { id: 'list-h' }, 'Names'),
    h('p', { class: 'muted small' }, 'Style for the next round: ', styleSummary(p.style)),
    h('div', { class: 'row wrap tabs', role: 'group', 'aria-label': 'Show' }, tab('play', 'In play'), tab('shortlist', 'Shortlist'), tab('rejected', 'Rejected'), tab('all', 'All')),
    cs.length
      ? h('ul', { class: 'cands' }, cs.map(row))
      : h(
          'p',
          { class: 'muted' },
          ws.filter === 'shortlist'
            ? 'Nothing kept yet. Press “Keep” on a name to add it to your shortlist.'
            : ws.filter === 'rejected'
              ? 'No rejected names. A rejected name never comes back in a later round.'
              : 'No names yet. Describe the company and generate a round.',
        ),
    counts.all
      ? h(
          'div',
          { class: 'toolbar row wrap' },
          h(
            'button',
            { disabled: !shortlistIds.length, onclick: () => void checkDomains(shortlistIds) },
            `Check .com for the ${counts.shortlist ? 'shortlist' : 'names in play'} (${shortlistIds.length}, ${checksLeft} checks left)`,
          ),
          selected.length
            ? h('button', { onclick: () => void checkDomains(selected) }, `Check selected (${selected.length})`)
            : null,
          selected.length >= 2 ? h('button', { onclick: compare }, `Compare selected (${selected.length})`) : null,
          h('button', { onclick: () => void copyShortlist() }, 'Copy shortlist'),
          h(
            'button',
            { onclick: () => download(`${p.name}.csv`, `/api/export?project=${p.id}&format=csv`) },
            'Download CSV',
          ),
          h(
            'button',
            { onclick: () => download(`${p.name}.txt`, `/api/export?project=${p.id}&format=txt&list=shortlist`) },
            'Download shortlist (text)',
          ),
        )
      : null,
    h('p', { class: 'muted small' }, 'A name with no valid .com form is marked not valid and spends no check. A lookup that cannot answer is shown as not known and spends nothing.'),
  )
}

// --- revisions ----------------------------------------------------------------------------

function renderRevise(): void {
  const p = ws.current
  if (!p || !state.me) return
  if (!p.candidates.length) {
    sections.revise.replaceChildren()
    return
  }
  const r = ws.round
  if (r && r.kind === 'revise') {
    mount(sections.revise, h('h2', { id: 'rev-h' }, 'Revise the list'), progress(r))
    return
  }
  const buildOn = p.candidates.filter((c) => ws.selected.has(c.id) && c.status !== 'rejected')
  const direction = h('textarea', {
    rows: 2,
    maxlength: 2000,
    placeholder: 'For example: shorter, warmer, more like the ones I kept',
    oninput: (e: Event) => (ws.revise.direction = (e.target as HTMLTextAreaElement).value),
  })
  direction.value = ws.revise.direction
  const avoid = h('input', {
    type: 'text',
    maxlength: 1000,
    value: ws.revise.avoid,
    placeholder: 'For example: anything ending in -ly, anything too technical',
    oninput: (e: Event) => (ws.revise.avoid = (e.target as HTMLInputElement).value),
  })
  mount(
    sections.revise,
    h('h2', { id: 'rev-h' }, 'Revise the list'),
    h('p', { class: 'muted small' }, 'Names you kept stay unless your direction removes them. Rejected names never return.'),
    h('label', {}, 'Direction', direction),
    h('label', {}, 'Qualities to avoid', avoid),
    h('p', { class: 'small' }, buildOn.length ? `Building on: ${buildOn.map((c) => c.name).join(', ')}` : 'Tip: select names in the list to build on them.'),
    levelPicker('rlevel', 'revise', ws.reviseLevel, (l) => (ws.reviseLevel = l)),
    h('button', { class: 'primary', disabled: !!ws.round, onclick: () => void startRound('revise') }, 'Revise'),
  )
}

// --- notes ------------------------------------------------------------------------------------

function renderNotesSafely(): void {
  // Never replace a note while the person is typing it.
  if (sections.notes.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA') {
    ws.pendingNotes = true
    return
  }
  renderNotes()
}

function renderNotes(): void {
  const p = ws.current
  if (!p) return
  const nameOf = (id: string | null) => (id ? p.candidates.find((c) => c.id === id)?.name ?? 'a removed name' : null)
  const conflicts = new Map<string, Note[]>()
  for (const n of p.notes) if (n.conflictOf) conflicts.set(n.conflictOf, [...(conflicts.get(n.conflictOf) ?? []), n])
  const editor = h('textarea', {
    rows: 3,
    maxlength: 5000,
    'aria-label': 'Note',
    oninput: (e: Event) => (ws.noteDraft = (e.target as HTMLTextAreaElement).value),
    onblur: () => {
      if (ws.pendingNotes) {
        ws.pendingNotes = false
        setTimeout(renderNotes, 0)
      }
    },
  })
  editor.value = ws.noteDraft
  const saveNew = async () => {
    if (!ws.noteDraft.trim()) return
    try {
      await api('POST', `/api/projects/${p.id}/notes`, { text: ws.noteDraft, candidateId: ws.noteFor })
      ws.noteDraft = ''
      ws.noteFor = null
      clearProblem()
      notice('Note saved.')
      await reloadCurrent()
      renderNotes()
    } catch (e) {
      showProblem(e, () => void saveNew())
    }
  }
  const noteItem = (n: Note) => {
    const others = conflicts.get(n.id) ?? []
    const edit = async () => {
      const ta = h('textarea', { rows: 4, value: n.body, 'aria-label': 'Edit note' })
      const ok = await dialog('Edit note', ta, [
        { label: 'Cancel', value: 'no' },
        { label: 'Save', value: 'yes', primary: true },
      ])
      if (ok !== 'yes') return
      const doIt = async () => {
        try {
          const res = await api<{ conflict: boolean }>('POST', `/api/projects/${p.id}/notes`, { noteId: n.id, text: ta.value, baseVersion: n.version })
          clearProblem()
          if (res.conflict) notice('Someone else saved this note at the same moment. Both versions are kept; choose one below.')
          await reloadCurrent()
          renderNotes()
        } catch (e) {
          showProblem(e, () => void doIt())
        }
      }
      await doIt()
    }
    const remove = async (id: string) => {
      try {
        await api('DELETE', `/api/projects/${p.id}/notes/${id}`)
        clearProblem()
        await reloadCurrent()
        renderNotes()
      } catch (e) {
        showProblem(e, () => void remove(id))
      }
    }
    return h(
      'li',
      { class: 'note' },
      nameOf(n.candidateId) ? h('p', { class: 'small' }, 'On ', h('strong', {}, nameOf(n.candidateId)!)) : null,
      h('p', { class: 'note-text' }, n.body),
      h('p', { class: 'muted small' }, n.author ? `${n.author} · ` : '', ago(n.updatedAt)),
      others.length
        ? h(
            'div',
            { class: 'banner' },
            h('p', {}, 'This note has two versions, saved at the same moment. Choose which to keep.'),
            others.map((o) =>
              h(
                'div',
                { class: 'version' },
                h('p', { class: 'note-text' }, o.body),
                h('p', { class: 'muted small' }, o.author ?? '', ' · ', ago(o.updatedAt)),
              ),
            ),
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'small', onclick: () => void Promise.all(others.map((o) => remove(o.id))) }, 'Keep the first version'),
              h('button', { class: 'small', onclick: () => void remove(n.id) }, 'Keep the other version'),
            ),
          )
        : null,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'small', onclick: () => void edit() }, 'Edit'),
        h('button', { class: 'small', onclick: () => void remove(n.id) }, 'Delete'),
      ),
    )
  }
  const roots = p.notes.filter((n) => !n.conflictOf)
  mount(
    sections.notes,
    h('h2', { id: 'notes-h' }, 'Notes'),
    roots.length ? h('ul', { class: 'notes' }, roots.map(noteItem)) : h('p', { class: 'muted' }, 'No notes yet.'),
    h(
      'form',
      {
        class: 'stack',
        onsubmit: (e: Event) => {
          e.preventDefault()
          void saveNew()
        },
      },
      h(
        'label',
        {},
        ws.noteFor ? `New note on ${nameOf(ws.noteFor)}` : 'New note',
        editor,
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'submit' }, 'Save note'),
        ws.noteFor ? h('button', { type: 'button', class: 'small', onclick: () => ((ws.noteFor = null), renderNotes()) }, 'Make it a project note') : null,
        p.shared ? h('span', { class: 'muted small' }, 'Others see a note only once you save it.') : null,
      ),
    ),
  )
}

export function leaveWorkspace(): void {
  closeLive()
  if (ws.tick) clearInterval(ws.tick as ReturnType<typeof setInterval>)
}

