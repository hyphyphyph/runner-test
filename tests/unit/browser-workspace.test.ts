import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { KeyValueStorage } from '../../src/local/types.ts'
import {
  allowancePeriod,
  BrowserWorkspace,
  WorkspaceError,
} from '../../src/local/workspace.ts'
import { MemoryStorage } from '../../src/local/memory-storage.ts'

let nextId = 0

function ids(): () => string {
  return () => `id-${++nextId}`
}

function openWorkspace(storage: KeyValueStorage, clock: { now: number }, prefix?: string): BrowserWorkspace {
  return new BrowserWorkspace({
    storage,
    now: () => clock.now,
    newId: ids(),
    ...(prefix === undefined ? {} : { prefix }),
  })
}

function refuses(code: string) {
  return (error: unknown): boolean => error instanceof WorkspaceError && error.code === code
}

const firstVisit = Date.parse('2026-10-23T12:00:00.000Z')

describe('anonymous browser identity', () => {
  test('the browser holds an anonymous identity with no email or password', () => {
    const storage = new MemoryStorage()
    const workspace = openWorkspace(storage, { now: firstVisit })

    const identity = workspace.identity()
    assert.match(identity.id, /^id-\d+$/)
    assert.equal(identity.createdAt, firstVisit)
    assert.equal(identity.allowanceAnchorDay, 23)
    assert.deepEqual(identity.usage, {
      period: '2026-10',
      rounds: 0,
      revisions: 0,
      checks: 0,
      updatedAt: firstVisit,
    })

    const raw = storage.getItem('nametempest.anonymous.v1.identity') ?? ''
    assert.ok(raw.length > 0)
    assert.doesNotMatch(raw, /email|password/i)
    assert.ok(!Object.hasOwn(identity, 'email'))
    assert.ok(!Object.hasOwn(identity, 'password'))
  })

  test('the identity is the same on the next visit and new after storage is cleared', () => {
    const storage = new MemoryStorage()
    const first = openWorkspace(storage, { now: firstVisit })
    const original = first.identity()

    const second = openWorkspace(storage, { now: firstVisit + 60_000 })
    assert.equal(second.identity().id, original.id)

    storage.clear()
    const cleared = openWorkspace(storage, { now: firstVisit + 120_000 })
    assert.notEqual(cleared.identity().id, original.id)
  })

  test('usage is counted against the identity and refreshes on the anchor day', () => {
    const storage = new MemoryStorage()
    const clock = { now: firstVisit }
    const workspace = openWorkspace(storage, clock)
    const project = workspace.createProject({ name: 'Acme' })

    workspace.recordUsage(project.id, { rounds: 2, checks: 3 })
    assert.equal(workspace.identity().usage.rounds, 2)
    assert.equal(workspace.identity().usage.checks, 3)

    // One day before the next anchor day still belongs to the same period.
    clock.now = Date.parse('2026-11-22T12:00:00.000Z')
    workspace.recordUsage(project.id, { checks: 1 })
    assert.equal(workspace.identity().usage.period, '2026-10')
    assert.equal(workspace.identity().usage.checks, 4)

    // On the anchor day the identity counters start again, while the
    // project's own lifetime usage stays as it was.
    clock.now = Date.parse('2026-11-23T12:00:00.000Z')
    workspace.recordUsage(project.id, { rounds: 1 })
    assert.deepEqual(
      {
        period: workspace.identity().usage.period,
        rounds: workspace.identity().usage.rounds,
        checks: workspace.identity().usage.checks,
      },
      { period: '2026-11', rounds: 1, checks: 0 },
    )
    assert.equal(workspace.project(project.id)?.usage.rounds, 3)
    assert.equal(workspace.project(project.id)?.usage.checks, 4)
  })

  test('the allowance period is clamped to the last day of a short month', () => {
    const anchor31 = Date.parse('2026-01-31T12:00:00.000Z')
    assert.equal(allowancePeriod(anchor31, 31), '2026-01')
    assert.equal(allowancePeriod(Date.parse('2026-02-27T12:00:00.000Z'), 31), '2026-01')
    assert.equal(allowancePeriod(Date.parse('2026-02-28T12:00:00.000Z'), 31), '2026-02')
    assert.equal(allowancePeriod(Date.parse('2026-03-30T12:00:00.000Z'), 31), '2026-02')
    assert.equal(allowancePeriod(Date.parse('2026-03-31T12:00:00.000Z'), 31), '2026-03')
  })
})

describe('browser-local projects', () => {
  test('one browser holds several projects with generated names', () => {
    const workspace = openWorkspace(new MemoryStorage(), { now: firstVisit })

    const first = workspace.createProject()
    const second = workspace.createProject()
    const third = workspace.createProject()

    assert.equal(first.name, 'Untitled project')
    assert.equal(second.name, 'Untitled project 2')
    assert.equal(third.name, 'Untitled project 3')
    assert.deepEqual(
      workspace.listProjects().map((project) => project.id),
      [first.id, second.id, third.id],
    )
    assert.equal(workspace.activeProjectId(), third.id)
  })

  test('a project has a name the person can change, and it survives a reload', () => {
    const storage = new MemoryStorage()
    const clock = { now: firstVisit }
    const workspace = openWorkspace(storage, clock)
    const project = workspace.createProject({ name: '  Acme  ' })
    assert.equal(project.name, 'Acme')

    workspace.renameProject(project.id, '  Northwind Studio  ')
    assert.equal(workspace.project(project.id)?.name, 'Northwind Studio')

    const reloaded = openWorkspace(storage, clock)
    assert.equal(reloaded.project(project.id)?.name, 'Northwind Studio')
  })

  test('a project name cannot be emptied', () => {
    const workspace = openWorkspace(new MemoryStorage(), { now: firstVisit })
    const project = workspace.createProject({ name: 'Acme' })

    assert.throws(() => workspace.renameProject(project.id, '   '), refuses('name_required'))
    assert.equal(workspace.project(project.id)?.name, 'Acme')
  })

  test('switching projects never mixes candidates, notes, rejections, results or usage', () => {
    const storage = new MemoryStorage()
    const clock = { now: firstVisit }
    const workspace = openWorkspace(storage, clock)

    const acme = workspace.createProject({ name: 'Acme', description: 'A tool for writers.' })
    workspace.addCandidate(acme.id, {
      name: 'Quillstead',
      reason: 'A settled place to write.',
      styleTag: 'warm',
      suggestedEndings: [{ ending: 'io', reason: 'Short and common with software.' }],
    })
    workspace.rejectName(acme.id, 'Oldname')
    workspace.addNote(acme.id, { name: 'Quillstead', body: 'Zoë likes this one.' })
    workspace.addDomainResult(acme.id, { name: 'Quillstead', ending: 'com', status: 'available' })
    workspace.addPendingCheck(acme.id, { name: 'Quillstead', ending: 'io' })
    workspace.recordUsage(acme.id, { rounds: 1, checks: 2 })

    const bakery = workspace.createProject({ name: 'Bakery', description: 'Bread and pastry.' })
    workspace.addCandidate(bakery.id, { name: 'Brightloaf', reason: 'Warm and simple.', styleTag: 'playful' })
    workspace.rejectName(bakery.id, 'Doughy')
    workspace.addNote(bakery.id, { name: 'Brightloaf', body: 'Ask the baker.' })
    workspace.addDomainResult(bakery.id, { name: 'Brightloaf', ending: 'com', status: 'taken' })
    workspace.addPendingCheck(bakery.id, { name: 'Brightloaf', ending: 'studio' })
    workspace.recordUsage(bakery.id, { rounds: 1, revisions: 1 })

    const projectA = workspace.project(acme.id)
    const projectB = workspace.project(bakery.id)
    assert.ok(projectA !== null && projectB !== null)

    assert.deepEqual(projectA.candidates.map((candidate) => candidate.name), ['Quillstead'])
    assert.deepEqual(projectB.candidates.map((candidate) => candidate.name), ['Brightloaf'])
    assert.deepEqual(projectA.rejectedNames.map((entry) => entry.name), ['Oldname'])
    assert.deepEqual(projectB.rejectedNames.map((entry) => entry.name), ['Doughy'])
    assert.deepEqual(projectA.notes.map((note) => note.body), ['Zoë likes this one.'])
    assert.deepEqual(projectB.notes.map((note) => note.body), ['Ask the baker.'])
    assert.deepEqual(projectA.domainResults.map((result) => result.name), ['Quillstead'])
    assert.deepEqual(projectB.domainResults.map((result) => result.name), ['Brightloaf'])
    assert.deepEqual(projectA.pendingChecks.map((check) => check.ending), ['io'])
    assert.deepEqual(projectB.pendingChecks.map((check) => check.ending), ['studio'])
    assert.deepEqual(projectA.usage, { rounds: 1, revisions: 0, checks: 2, credits: 0, updatedAt: firstVisit })
    assert.deepEqual(projectB.usage, { rounds: 1, revisions: 1, checks: 0, credits: 0, updatedAt: firstVisit })

    // The two stored documents do not hold each other's text.
    const rawA = storage.getItem(workspace.storageKeyForProject(acme.id)) ?? ''
    const rawB = storage.getItem(workspace.storageKeyForProject(bakery.id)) ?? ''
    assert.match(rawA, /Quillstead/)
    assert.doesNotMatch(rawA, /Brightloaf|Brightloaf|Doughy|Ask the baker/)
    assert.match(rawB, /Brightloaf/)
    assert.doesNotMatch(rawB, /Quillstead|Oldname|Zoë likes this one/)

    // Switching the open project does not move anything between them.
    workspace.setActiveProject(acme.id)
    assert.equal(workspace.activeProject()?.name, 'Acme')
    assert.deepEqual(workspace.activeProject()?.candidates.map((candidate) => candidate.name), ['Quillstead'])
    workspace.setActiveProject(bakery.id)
    assert.equal(workspace.activeProject()?.name, 'Bakery')
    assert.deepEqual(workspace.activeProject()?.candidates.map((candidate) => candidate.name), ['Brightloaf'])

    const reloaded = openWorkspace(storage, clock)
    assert.equal(reloaded.activeProject()?.name, 'Bakery')
    assert.deepEqual(
      reloaded.listProjects().map((project) => [project.name, project.candidateCount, project.noteCount]),
      [
        ['Acme', 1, 1],
        ['Bakery', 1, 1],
      ],
    )

    // An edit to one project is not visible in the other.
    reloaded.updateProject(acme.id, { description: 'Changed for Acme only.' })
    assert.equal(reloaded.project(acme.id)?.description, 'Changed for Acme only.')
    assert.equal(reloaded.project(bakery.id)?.description, 'Bread and pastry.')
  })

  test('deleting a project removes its contents and leaves the other projects whole', () => {
    const storage = new MemoryStorage()
    const workspace = openWorkspace(storage, { now: firstVisit })

    const keep = workspace.createProject({ name: 'Keep' })
    workspace.addCandidate(keep.id, { name: 'Quillstead' })
    workspace.addNote(keep.id, { name: 'Quillstead', body: 'Keep this note.' })
    workspace.recordUsage(keep.id, { checks: 1 })

    const remove = workspace.createProject({ name: 'Remove' })
    workspace.addCandidate(remove.id, { name: 'Oldname' })
    workspace.addNote(remove.id, { name: 'Oldname', body: 'Remove this note.' })
    workspace.rejectName(remove.id, 'Unwanted')
    workspace.recordUsage(remove.id, { rounds: 2 })
    const removeKey = workspace.storageKeyForProject(remove.id)

    workspace.setActiveProject(remove.id)
    assert.equal(workspace.deleteProject(remove.id), true)

    assert.equal(workspace.project(remove.id), null)
    assert.equal(storage.getItem(removeKey), null)
    assert.deepEqual(workspace.listProjects().map((project) => project.id), [keep.id])
    assert.equal(workspace.activeProjectId(), keep.id)
    assert.deepEqual(workspace.project(keep.id)?.notes.map((note) => note.body), ['Keep this note.'])
    assert.equal(workspace.project(keep.id)?.usage.checks, 1)

    // A second delete changes nothing.
    assert.equal(workspace.deleteProject(remove.id), false)

    // The remaining project can still be reloaded from the same storage.
    const reloaded = openWorkspace(storage, { now: firstVisit })
    assert.deepEqual(reloaded.listProjects().map((project) => project.name), ['Keep'])
  })

  test('deleting the last project leaves the browser with no open project', () => {
    const workspace = openWorkspace(new MemoryStorage(), { now: firstVisit })
    const project = workspace.createProject({ name: 'Only' })
    assert.equal(workspace.deleteProject(project.id), true)
    assert.deepEqual(workspace.listProjects(), [])
    assert.equal(workspace.activeProjectId(), null)
    assert.equal(workspace.activeProject(), null)
  })

  test('a project holds description, industry and all six style fields', () => {
    const workspace = openWorkspace(new MemoryStorage(), { now: firstVisit })
    const project = workspace.createProject({
      name: 'Acme',
      description: 'We build things.',
      industry: 'software',
      style: { tone: 'warm', preferredEndings: ['.COM', 'studio'] },
    })

    assert.equal(project.description, 'We build things.')
    assert.equal(project.industry, 'software')
    assert.deepEqual(project.style, {
      namingStyle: '',
      tone: 'warm',
      length: '',
      include: '',
      avoid: '',
      preferredEndings: ['com', 'studio'],
    })

    workspace.updateProject(project.id, {
      style: { namingStyle: 'invented', length: 'one-word', include: 'light' },
    })
    const updated = workspace.project(project.id)
    assert.equal(updated?.style.namingStyle, 'invented')
    assert.equal(updated?.style.length, 'one-word')
    assert.equal(updated?.style.include, 'light')
    assert.equal(updated?.style.tone, 'warm')
    assert.deepEqual(updated?.style.preferredEndings, ['com', 'studio'])
  })

  test('candidate endings are bare, deduplicated and limited to five', () => {
    const workspace = openWorkspace(new MemoryStorage(), { now: firstVisit })
    const project = workspace.createProject({ name: 'Acme' })

    const candidate = workspace.addCandidate(project.id, {
      name: 'Quillstead',
      suggestedEndings: [
        { ending: '.COM', reason: 'Familiar.' },
        { ending: 'com', reason: 'Repeated.' },
        { ending: 'io', reason: 'Short.' },
      ],
    }).candidates[0]
    assert.ok(candidate !== undefined)
    assert.deepEqual(
      candidate.suggestedEndings.map((ending) => ending.ending),
      ['com', 'io'],
    )

    assert.throws(
      () => workspace.addCandidate(project.id, { name: 'quillstead' }),
      refuses('candidate_duplicate'),
    )
    assert.throws(
      () =>
        workspace.addCandidate(project.id, {
          name: 'Other',
          suggestedEndings: ['a', 'b', 'c', 'd', 'e', 'f'].map((ending) => ({ ending, reason: '' })),
        }),
      refuses('endings_too_many'),
    )
    assert.throws(
      () => workspace.addCandidate(project.id, { name: 'Other', suggestedEndings: [{ ending: 'not valid', reason: '' }] }),
      refuses('ending_invalid'),
    )
  })

  test('a damaged project is skipped and never blocks another project', () => {
    const storage = new MemoryStorage()
    const workspace = openWorkspace(storage, { now: firstVisit })
    const good = workspace.createProject({ name: 'Good' })
    const damaged = workspace.createProject({ name: 'Damaged' })
    workspace.addCandidate(good.id, { name: 'Quillstead' })

    storage.setItem(workspace.storageKeyForProject(damaged.id), '{not json')

    assert.deepEqual(workspace.listProjects().map((project) => project.name), ['Good'])
    assert.equal(workspace.project(damaged.id), null)
    assert.deepEqual(workspace.project(good.id)?.candidates.map((candidate) => candidate.name), ['Quillstead'])
  })

  test('the store can be given its own namespace', () => {
    const storage = new MemoryStorage()
    const one = openWorkspace(storage, { now: firstVisit }, 'one.v1')
    const two = openWorkspace(storage, { now: firstVisit }, 'two.v1')

    const first = one.createProject({ name: 'First' })
    const second = two.createProject({ name: 'Second' })

    assert.deepEqual(one.listProjects().map((project) => project.name), ['First'])
    assert.deepEqual(two.listProjects().map((project) => project.name), ['Second'])
    assert.notEqual(first.id, second.id)
  })
})
