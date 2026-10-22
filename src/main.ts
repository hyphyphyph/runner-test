import './style.css'
import { api } from '../shared/client.ts'
import type { AnonymousIdentity, Candidate, DomainResult, Project, ProjectSummary, StyleChoices } from './local/types.ts'
import { hasRoundLeft, remainingAllowance } from './local/allowance.ts'
import { MemoryStorage } from './local/memory-storage.ts'
import { ANONYMOUS_STORAGE_PREFIX, BrowserWorkspace, WorkspaceError } from './local/workspace.ts'

const app = document.querySelector<HTMLDivElement>('#app')!

interface Notice {
  kind: 'error' | 'info'
  text: string
}

function openBrowserStorage(): { storage: Storage | MemoryStorage; persistent: boolean } {
  try {
    const storage = window.localStorage
    const probe = `${ANONYMOUS_STORAGE_PREFIX}.probe`
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return { storage, persistent: true }
  } catch {
    return { storage: new MemoryStorage(), persistent: false }
  }
}

const opened = openBrowserStorage()
const workspace = new BrowserWorkspace({ storage: opened.storage })

let notice: Notice | null = opened.persistent
  ? null
  : {
      kind: 'error',
      text: 'This browser is not letting the page save work. You can still use the page, but everything disappears when the tab closes.',
    }

let serverLine = 'Server status: checking…'
let serverState = 'checking'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function summaryLine(project: ProjectSummary): string {
  const pieces = [plural(project.candidateCount, 'name', 'names')]
  if (project.noteCount > 0) pieces.push(plural(project.noteCount, 'note', 'notes'))
  if (project.rejectedNameCount > 0) pieces.push(plural(project.rejectedNameCount, 'rejected', 'rejected'))
  return pieces.join(' · ')
}

/**
 * The remaining free allowance, in words a person reads at a glance. It is
 * rendered on every visit, in every project, and while a project is empty.
 */
function renderAllowance(identity: AnonymousIdentity): string {
  const remaining = remainingAllowance(identity.usage)
  const counts = [
    plural(remaining.rounds, 'round', 'rounds'),
    plural(remaining.revisions, 'revision', 'revisions'),
    plural(remaining.checks, 'check', 'checks'),
  ].join(' · ')

  return `
    <section
      class="allowance-slot"
      id="allowance"
      data-allowance="remaining"
      data-remaining-rounds="${remaining.rounds}"
      aria-label="Remaining free allowance"
    >
      <span class="allowance-label">Free allowance remaining</span>
      <strong class="allowance-value">${escapeHtml(counts)} this month</strong>
      <span class="allowance-note">Saved in this browser · nothing to install</span>
    </section>
  `
}

/** A round needs a round's worth of free allowance. */
function canAffordRound(identity: AnonymousIdentity): boolean {
  return hasRoundLeft(remainingAllowance(identity.usage))
}

function formatTime(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
  } catch {
    return new Date(value).toISOString()
  }
}

function messageFor(error: unknown): string {
  if (error instanceof WorkspaceError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong while saving this project.'
}

function perform(action: () => void): void {
  try {
    action()
    notice = null
  } catch (error) {
    notice = { kind: 'error', text: messageFor(error) }
  }
  render()
}

/** Keep the generate control in step with the allowance that remains. */
function syncGenerateButton(): void {
  const button = app.querySelector<HTMLButtonElement>('button[data-action="generate"]')
  if (button === null) return
  button.disabled = !canAffordRound(workspace.identity())
}

/** Put the cursor where the required description is written. */
function focusDescription(): void {
  app.querySelector<HTMLTextAreaElement>('textarea[data-field="description"]')?.focus()
}

function domainLabel(status: DomainResult['status']): string {
  switch (status) {
    case 'available':
      return 'Free'
    case 'taken':
      return 'Taken'
    case 'unknown':
      return 'Unknown'
    case 'not_valid':
      return 'Not a valid domain'
  }
}

function latestResult(project: Project, name: string, ending: string): DomainResult | undefined {
  return project.domainResults
    .filter(
      (result) =>
        result.name.toLowerCase() === name.toLowerCase() && result.ending === ending,
    )
    .sort((a, b) => b.checkedAt - a.checkedAt)[0]
}

function pendingFor(project: Project, name: string, ending: string): string | undefined {
  return project.pendingChecks.find(
    (check) => check.name.toLowerCase() === name.toLowerCase() && check.ending === ending,
  )?.status
}

function endingNames(project: Project, candidate: Candidate): string[] {
  const names: string[] = []
  for (const ending of candidate.suggestedEndings) {
    if (!names.includes(ending.ending)) names.push(ending.ending)
  }
  for (const result of project.domainResults) {
    if (result.name.toLowerCase() === candidate.name.toLowerCase() && !names.includes(result.ending)) {
      names.push(result.ending)
    }
  }
  return names
}

function renderNotice(): string {
  if (notice === null) return ''
  return `
    <div class="notice notice-${notice.kind}" role="status">
      <p>${escapeHtml(notice.text)}</p>
      <button class="button quiet small" type="button" data-action="dismiss-notice">Dismiss</button>
    </div>
  `
}

function renderProjectList(projects: ProjectSummary[], activeId: string | null): string {
  if (projects.length === 0) {
    return `<p class="sidebar-empty">No projects yet. Make one to start naming.</p>`
  }

  return projects
    .map(
      (project) => `
        <button
          class="project-link${project.id === activeId ? ' is-active' : ''}"
          type="button"
          data-action="select-project"
          data-id="${escapeHtml(project.id)}"
          aria-current="${project.id === activeId ? 'page' : 'false'}"
        >
          <span class="project-link-name">${escapeHtml(project.name)}</span>
          <span class="project-link-meta">${summaryLine(project)}</span>
        </button>
      `,
    )
    .join('')
}

/**
 * A compact project switcher beside the fuller project list. It stays usable
 * when the list is long or the page is narrow, and it names the open project
 * with its real name rather than the word "project".
 */
function renderProjectSwitcher(projects: ProjectSummary[], activeId: string | null): string {
  if (projects.length === 0) {
    return `
      <label class="project-switcher">
        <span class="label-text">Switch project</span>
        <select id="project-switcher" aria-label="Project switcher" disabled>
          <option>No projects yet</option>
        </select>
      </label>
    `
  }

  return `
    <label class="project-switcher">
      <span class="label-text">Switch project</span>
      <select id="project-switcher" aria-label="Project switcher">
        ${projects
          .map(
            (project) =>
              `<option value="${escapeHtml(project.id)}"${project.id === activeId ? ' selected' : ''}>${escapeHtml(project.name)}</option>`,
          )
          .join('')}
      </select>
    </label>
  `
}

/** The product explanation shown before anything has been generated. */
function renderIntro(): string {
  return `
    <section class="intro" aria-labelledby="intro-heading">
      <p class="eyebrow">Company naming</p>
      <h2 id="intro-heading">Find a name you would be glad to use.</h2>
      <p>
        NameTempest turns a plain description of your company into a round of
        name candidates. Each name comes with a sentence on why it fits and up
        to five other endings worth checking. Keep the names you like, check
        which have a .com domain that is still free to register, and tick any
        suggested endings you want checked too.
      </p>
      <p class="muted small">
        One workspace for a solo founder, a small business or an agency naming
        for several clients.
      </p>
    </section>
  `
}

function renderCandidate(project: Project, candidate: Candidate): string {
  const endings = endingNames(project, candidate)
  const endingRows =
    endings.length === 0
      ? `<p class="muted small">No endings suggested or checked yet.</p>`
      : `<ul class="ending-list">
          ${endings
            .map((ending) => {
              const suggestion = candidate.suggestedEndings.find((item) => item.ending === ending)
              const result = latestResult(project, candidate.name, ending)
              const pending = pendingFor(project, candidate.name, ending)
              const status = result
                ? `<span class="chip chip-${result.status}">${domainLabel(result.status)}</span>
                   <span class="muted tiny">${escapeHtml(formatTime(result.checkedAt))}</span>`
                : pending !== undefined
                  ? `<span class="chip chip-pending">Check ${escapeHtml(pending)}</span>`
                  : `<span class="muted tiny">Not checked</span>`
              return `
                <li>
                  <span class="ending">.${escapeHtml(ending)}</span>
                  ${suggestion ? `<span class="ending-reason">${escapeHtml(suggestion.reason)}</span>` : ''}
                  <span class="ending-status">${status}</span>
                </li>
              `
            })
            .join('')}
        </ul>`

  return `
    <article class="candidate">
      <div class="candidate-head">
        <h3>${escapeHtml(candidate.name)}</h3>
        ${candidate.styleTag ? `<span class="tag">${escapeHtml(candidate.styleTag)}</span>` : ''}
      </div>
      ${candidate.reason ? `<p class="candidate-reason">${escapeHtml(candidate.reason)}</p>` : ''}
      ${endingRows}
    </article>
  `
}

function renderNames(project: Project): string {
  if (project.candidates.length === 0) {
    return `<p class="empty-state">No names yet. When a generation round runs, every name stays here with its reason, style tag and suggested endings.</p>`
  }
  return `<div class="candidate-list">${project.candidates.map((candidate) => renderCandidate(project, candidate)).join('')}</div>`
}

function renderRejected(project: Project): string {
  const rows =
    project.rejectedNames.length === 0
      ? `<p class="muted small">No rejected names in this project.</p>`
      : `<ul class="plain-list">
          ${project.rejectedNames
            .map(
              (entry) => `
                <li>
                  <span>${escapeHtml(entry.name)}</span>
                  <span class="muted tiny">${escapeHtml(formatTime(entry.rejectedAt))}</span>
                  <button
                    class="button quiet small"
                    type="button"
                    data-action="unreject-name"
                    data-name="${escapeHtml(entry.name)}"
                  >Allow again</button>
                </li>
              `,
            )
            .join('')}
        </ul>`

  return `
    <section class="card">
      <div class="section-head">
        <div>
          <h2>Rejected names</h2>
          <p class="muted small">A rejected name never comes back in this project.</p>
        </div>
        <span class="count">${project.rejectedNames.length}</span>
      </div>
      ${rows}
      <form class="inline-form" data-form="reject-name">
        <label>
          <span class="label-text">Reject a name</span>
          <input name="name" type="text" placeholder="Name to reject" autocomplete="off" />
        </label>
        <button class="button small" type="submit">Reject</button>
      </form>
    </section>
  `
}

function renderNotes(project: Project): string {
  const rows =
    project.notes.length === 0
      ? `<p class="muted small">No notes in this project.</p>`
      : `<ul class="note-list">
          ${project.notes
            .map(
              (note) => `
                <li>
                  <div class="note-head">
                    <strong>${escapeHtml(note.name)}</strong>
                    <span class="muted tiny">${escapeHtml(formatTime(note.updatedAt))}</span>
                    <button
                      class="button quiet small"
                      type="button"
                      data-action="delete-note"
                      data-note-id="${escapeHtml(note.id)}"
                    >Delete</button>
                  </div>
                  <p>${escapeHtml(note.body)}</p>
                </li>
              `,
            )
            .join('')}
        </ul>`

  return `
    <section class="card">
      <div class="section-head">
        <div>
          <h2>Notes</h2>
          <p class="muted small">Notes belong to this project alone.</p>
        </div>
        <span class="count">${project.notes.length}</span>
      </div>
      ${rows}
      <form class="note-form" data-form="add-note">
        <label>
          <span class="label-text">Name</span>
          <input name="name" type="text" placeholder="Which name is this about?" autocomplete="off" />
        </label>
        <label>
          <span class="label-text">Note</span>
          <textarea name="body" rows="3" placeholder="A thought, a concern, something to remember"></textarea>
        </label>
        <button class="button small" type="submit">Add note</button>
      </form>
    </section>
  `
}

function renderChecks(project: Project): string {
  const pending =
    project.pendingChecks.length === 0
      ? `<p class="muted small">No ticked checks waiting.</p>`
      : `<ul class="plain-list">
          ${project.pendingChecks
            .map(
              (check) => `
                <li>
                  <span>${escapeHtml(check.name)}.${escapeHtml(check.ending)}</span>
                  <span class="chip chip-pending">${escapeHtml(check.status)}</span>
                  <span class="muted tiny">${escapeHtml(formatTime(check.requestedAt))}</span>
                </li>
              `,
            )
            .join('')}
        </ul>`

  const results =
    project.domainResults.length === 0
      ? `<p class="muted small">No domain results in this project.</p>`
      : `<ul class="plain-list">
          ${[...project.domainResults]
            .sort((a, b) => b.checkedAt - a.checkedAt)
            .map(
              (result) => `
                <li>
                  <span>${escapeHtml(result.name)}.${escapeHtml(result.ending)}</span>
                  <span class="chip chip-${result.status}">${domainLabel(result.status)}</span>
                  <span class="muted tiny">${escapeHtml(formatTime(result.checkedAt))}</span>
                </li>
              `,
            )
            .join('')}
        </ul>`

  return `
    <section class="card">
      <div class="section-head">
        <div>
          <h2>Domain checks</h2>
          <p class="muted small">One answer belongs to one name and ending pair.</p>
        </div>
        <span class="count">${project.domainResults.length}</span>
      </div>
      <div class="check-groups">
        <div>
          <h3 class="subhead">Ticked and waiting</h3>
          ${pending}
        </div>
        <div>
          <h3 class="subhead">Results</h3>
          ${results}
        </div>
      </div>
    </section>
  `
}

function renderStyle(project: Project): string {
  const nameOptions = [
    ['', 'No preference'],
    ['descriptive', 'Descriptive'],
    ['invented', 'Invented'],
    ['compound', 'Compound'],
    ['evocative', 'Evocative'],
  ]
  const toneOptions = [
    ['', 'No preference'],
    ['playful', 'Playful'],
    ['serious', 'Serious'],
    ['modern', 'Modern'],
    ['classic', 'Classic'],
  ]
  const lengthOptions = [
    ['', 'No preference'],
    ['one-word', 'One word'],
    ['two-words', 'Two words'],
  ]

  const options = (values: string[][], selected: string): string =>
    values
      .map(
        ([value, label]) =>
          `<option value="${escapeHtml(value ?? '')}"${value === selected ? ' selected' : ''}>${escapeHtml(label ?? '')}</option>`,
      )
      .join('')

  return `
    <section class="card">
      <div class="section-head">
        <div>
          <h2>Style choices</h2>
          <p class="muted small">A guide for the next round. Names already on the list never change.</p>
        </div>
      </div>
      <div class="style-grid">
        <label>
          <span class="label-text">Naming style</span>
          <select data-field="style.namingStyle">${options(nameOptions, project.style.namingStyle)}</select>
        </label>
        <label>
          <span class="label-text">Tone</span>
          <select data-field="style.tone">${options(toneOptions, project.style.tone)}</select>
        </label>
        <label>
          <span class="label-text">Length</span>
          <select data-field="style.length">${options(lengthOptions, project.style.length)}</select>
        </label>
        <label>
          <span class="label-text">Things to include</span>
          <input data-field="style.include" type="text" value="${escapeHtml(project.style.include)}" placeholder="Words or sounds" />
        </label>
        <label>
          <span class="label-text">Things to avoid</span>
          <input data-field="style.avoid" type="text" value="${escapeHtml(project.style.avoid)}" placeholder="Words or competitors" />
        </label>
        <label>
          <span class="label-text">Preferred endings</span>
          <input
            data-field="style.preferredEndings"
            type="text"
            value="${escapeHtml(project.style.preferredEndings.join(', '))}"
            placeholder="com, studio"
          />
          <span class="field-hint">Bare lower-case labels, separated by commas.</span>
        </label>
      </div>
    </section>
  `
}

function renderWorkspace(project: Project, identity: AnonymousIdentity): string {
  const generateAllowed = canAffordRound(identity)
  const hasWork =
    project.candidates.length > 0 ||
    project.domainResults.length > 0 ||
    project.pendingChecks.length > 0

  return `
    ${renderIntro()}

    <header class="project-head">
      <div class="project-title-row">
        <label class="sr-only" for="project-name">Project name</label>
        <input
          id="project-name"
          class="project-title"
          data-field="name"
          type="text"
          value="${escapeHtml(project.name)}"
          autocomplete="off"
        />
        <button class="button danger quiet" type="button" data-action="delete-project">Delete project</button>
      </div>
      <p class="project-meta">
        ${plural(project.candidates.length, 'name', 'names')} ·
        ${plural(project.domainResults.length, 'result', 'results')} ·
        ${plural(project.notes.length, 'note', 'notes')} ·
        updated ${escapeHtml(formatTime(project.updatedAt))}
      </p>
    </header>

    <section class="card brief-card" aria-labelledby="brief-heading">
      <div class="section-head">
        <div>
          <h2 id="brief-heading">Company</h2>
          <p class="muted small">Saved in this browser only. The description is the only required field.</p>
        </div>
      </div>
      <form class="brief-form" data-form="generate" novalidate>
        <label class="field">
          <span class="label-text">
            Company description
            <span class="required-mark">required</span>
          </span>
          <textarea
            name="description"
            data-field="description"
            rows="5"
            required
            aria-required="true"
            aria-describedby="description-hint"
            placeholder="Describe the company in your own words"
          >${escapeHtml(project.description)}</textarea>
          <span id="description-hint" class="field-hint">
            What does the company do, who is it for, and what should the name feel like?
          </span>
        </label>
        <label class="field field-narrow">
          <span class="label-text">
            Industry or category
            <span class="optional-mark">optional</span>
          </span>
          <input
            name="industry"
            data-field="industry"
            type="text"
            value="${escapeHtml(project.industry)}"
            placeholder="Such as software, bakery or design studio"
            autocomplete="off"
          />
        </label>
        <div class="generate-row">
          <button
            class="button primary"
            type="submit"
            data-action="generate"
            aria-describedby="generate-hint"
            ${generateAllowed ? '' : 'disabled'}
          >Generate names</button>
          <span id="generate-hint" class="muted small">
            A round spends from the free allowance shown above. A round that fails spends nothing.
          </span>
        </div>
      </form>
    </section>

    ${renderStyle(project)}

    <section class="card candidates-card" id="candidates" aria-labelledby="candidates-heading">
      <div class="section-head">
        <div>
          <h2 id="candidates-heading">Candidates</h2>
          <p class="muted small">Every name keeps its own reason, style and suggested endings.</p>
        </div>
        <span class="count">${project.candidates.length}</span>
      </div>
      ${renderNames(project)}
    </section>
    ${hasWork ? renderChecks(project) : ''}
    ${project.candidates.length > 0 ? renderRejected(project) : ''}
    ${project.candidates.length > 0 ? renderNotes(project) : ''}
  `
}


function render(): void {
  try {
    const identity = workspace.identity()
    // The naming workspace is the page, not a step behind a "create project"
    // button. A browser with no project opens on a new, empty one.
    const project = workspace.activeProject() ?? workspace.createProject()
    const projects = workspace.listProjects()
    const activeId = project.id

    app.innerHTML = `
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">N</span>
            <div>
              <h1>NameTempest</h1>
              <p class="tagline">Find a company name you would be glad to use.</p>
            </div>
          </div>
          ${renderAllowance(identity)}
        </header>

        ${renderNotice()}

        <div class="layout">
          <aside class="sidebar">
            <div class="sidebar-head">
              <h2>Projects</h2>
              <button class="button primary small" type="button" data-action="new-project">New project</button>
            </div>
            ${renderProjectSwitcher(projects, activeId)}
            <nav class="project-list" aria-label="Project list">
              ${renderProjectList(projects, activeId)}
            </nav>
            <div class="sidebar-foot">
              <p class="eyebrow">This browser</p>
              <p class="muted small">
                Projects stay here until you delete them. Clearing site data removes them.
              </p>
            </div>
          </aside>

          <main class="content">
            ${renderWorkspace(project, identity)}
          </main>
        </div>

        <footer class="footer">
          <span id="server-status" class="server-status" data-state="${serverState}">${escapeHtml(serverLine)}</span>
          <span>nametempest.com</span>
        </footer>
      </div>
    `
  } catch (error) {
    app.innerHTML = `
      <div class="shell">
        <div class="fatal" role="alert">
          <h1>NameTempest</h1>
          <p>${escapeHtml(messageFor(error))}</p>
          <button class="button primary" type="button" data-action="new-project">Try again</button>
        </div>
      </div>
    `
  }
}

function stylePatch(field: string, raw: string): Partial<StyleChoices> | null {
  switch (field) {
    case 'style.namingStyle':
      return { namingStyle: raw }
    case 'style.tone':
      return { tone: raw }
    case 'style.length':
      return { length: raw }
    case 'style.include':
      return { include: raw }
    case 'style.avoid':
      return { avoid: raw }
    case 'style.preferredEndings':
      return {
        preferredEndings: raw
          .split(',')
          .map((ending) => ending.trim())
          .filter((ending) => ending.length > 0),
      }
    default:
      return null
  }
}

app.addEventListener('click', (event) => {
  const element = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action]') : null
  if (element === null) return

  const action = element.dataset.action
  const active = workspace.activeProject()

  switch (action) {
    case 'new-project':
      perform(() => {
        workspace.createProject()
      })
      break
    case 'select-project': {
      const id = element.dataset.id
      if (id !== undefined) perform(() => workspace.setActiveProject(id))
      break
    }
    case 'delete-project': {
      if (active === null) break
      const confirmed = window.confirm(
        `Delete “${active.name}”? Its names, notes, rejected names, check results and usage are removed from this browser.`,
      )
      if (!confirmed) break
      perform(() => {
        workspace.deleteProject(active.id)
      })
      break
    }
    case 'delete-note': {
      if (active === null) break
      const noteId = element.dataset.noteId
      if (noteId !== undefined) perform(() => workspace.deleteNote(active.id, noteId))
      break
    }
    case 'unreject-name': {
      if (active === null) break
      const name = element.dataset.name
      if (name !== undefined) perform(() => workspace.unrejectName(active.id, name))
      break
    }
    case 'dismiss-notice':
      notice = null
      render()
      break
    default:
      break
  }
})

app.addEventListener('change', (event) => {
  const target = event.target
  if (
    !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
  ) {
    return
  }

  if (target instanceof HTMLSelectElement && target.id === 'project-switcher') {
    const id = target.value
    if (id.length > 0) perform(() => workspace.setActiveProject(id))
    return
  }

  const field = target.dataset.field
  if (field === undefined) return
  const active = workspace.activeProject()
  if (active === null) return

  if (field === 'name') {
    perform(() => workspace.renameProject(active.id, target.value))
    return
  }
  if (field === 'description') {
    perform(() => workspace.updateProject(active.id, { description: target.value }))
    return
  }
  if (field === 'industry') {
    perform(() => workspace.updateProject(active.id, { industry: target.value }))
    return
  }

  const style = stylePatch(field, target.value)
  if (style !== null) {
    perform(() => workspace.updateProject(active.id, { style }))
  }
})

// The company fields save as the person writes, so switching projects or
// closing the tab never loses a description they were in the middle of.
app.addEventListener('input', (event) => {
  const target = event.target
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return
  const field = target.dataset.field
  if (field !== 'description' && field !== 'industry') return

  const active = workspace.activeProject()
  if (active === null) return

  try {
    if (field === 'description') {
      workspace.updateProject(active.id, { description: target.value })
    } else {
      workspace.updateProject(active.id, { industry: target.value })
    }
    syncGenerateButton()
  } catch (error) {
    notice = { kind: 'error', text: messageFor(error) }
    render()
  }
})

app.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  const target = event.target
  if (target instanceof HTMLInputElement && target.dataset.field === 'name') {
    event.preventDefault()
    target.blur()
  }
})

app.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  event.preventDefault()

  const active = workspace.activeProject()
  if (active === null) return

  const data = new FormData(form)
  const kind = form.dataset.form
  if (kind === 'generate') {
    const description = active.description.trim()
    if (description.length === 0) {
      notice = { kind: 'error', text: 'Write a company description before generating names.' }
      render()
      focusDescription()
      return
    }

    if (!hasRoundLeft(remainingAllowance(workspace.identity().usage))) {
      notice = {
        kind: 'info',
        text: 'The free allowance for this month is used up. Everything already on screen stays here.',
      }
      render()
      return
    }

    // Generation is built as its own work item. Until it is connected here,
    // the control saves the brief and spends nothing rather than pretending a
    // round ran.
    notice = {
      kind: 'info',
      text: 'Name generation is not connected in this step yet. Your company description is saved and no allowance was spent.',
    }
    render()
  } else if (kind === 'add-note') {
    const name = String(data.get('name') ?? '')
    const body = String(data.get('body') ?? '')
    perform(() => workspace.addNote(active.id, { name, body }))
  } else if (kind === 'reject-name') {
    const name = String(data.get('name') ?? '')
    perform(() => workspace.rejectName(active.id, name))
  }
})

window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key.startsWith(ANONYMOUS_STORAGE_PREFIX)) render()
})

function refreshServerStatus(): void {
  api
    .health()
    .then((health) => {
      serverState = health.status === 'ok' ? 'ok' : 'degraded'
      serverLine = `Server ${health.status} · database ${health.database.status}`
    })
    .catch(() => {
      serverState = 'unreachable'
      serverLine = 'Server not reachable · your projects still work in this browser'
    })
    .finally(() => {
      const element = document.querySelector<HTMLSpanElement>('#server-status')
      if (element !== null) {
        element.dataset.state = serverState
        element.textContent = serverLine
      }
    })
}

render()
refreshServerStatus()
