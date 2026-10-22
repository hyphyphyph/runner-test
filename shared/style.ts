// The six-field style form and the pick lists behind it.
//
// Generation.styleForm, Generation.styleRules and Generation.preferredEndings
// say what the form asks for. This module holds the shipped lists, the rules
// that filter an ending to the ones that may be suggested or ticked, and the
// shape the model receives. It has no browser or server dependency.

/** One pick the operator can offer in the naming style or tone list. */
export interface StyleOption {
  /** Stable value saved with a project. */
  id: string
  /** Words a person reads in the pick list. */
  label: string
}

/**
 * The lists behind the form.
 *
 * `endings` is the operator's ending pick list, already filtered to endings
 * that pass DomainCheck.offeredEndings. `offeredEndings` is the wider set the
 * ending pick list is allowed to draw from.
 */
export interface StyleLists {
  namingStyles: StyleOption[]
  tones: StyleOption[]
  endings: string[]
  offeredEndings: string[]
}

/** The six fields of the form, with strings a project stores. */
export interface StyleChoiceValues {
  namingStyle: string
  tone: string
  length: string
  include: string
  avoid: string
  preferredEndings: string[]
}

/**
 * The length field is fixed by the specification: one word, two words, or no
 * preference. The empty value is the "no preference" choice.
 */
export const LENGTH_OPTIONS: readonly StyleOption[] = Object.freeze([
  { id: 'one-word', label: 'One word' },
  { id: 'two-words', label: 'Two words' },
])

/**
 * The shipped naming style list. It is a starting value for the operator's
 * list, not a hard-coded set in the form.
 */
export const SHIPPED_NAMING_STYLES: readonly StyleOption[] = Object.freeze([
  { id: 'descriptive', label: 'Descriptive' },
  { id: 'invented', label: 'Invented' },
  { id: 'compound', label: 'Compound' },
  { id: 'evocative', label: 'Evocative' },
])

/** The shipped tone list, also a starting value for the operator's list. */
export const SHIPPED_TONES: readonly StyleOption[] = Object.freeze([
  { id: 'playful', label: 'Playful' },
  { id: 'serious', label: 'Serious' },
  { id: 'modern', label: 'Modern' },
  { id: 'classic', label: 'Classic' },
])

/**
 * The shipped ending list. Every ending here is one the first version may
 * suggest and check. The refreshed root zone list, the lookup route and the
 * registry terms decide the real offered set under DomainCheck.offeredEndings;
 * this is the starting set until that refresh is connected.
 */
export const SHIPPED_OFFERED_ENDINGS: readonly string[] = Object.freeze([
  'com',
  'io',
  'co',
  'studio',
  'design',
  'shop',
  'tech',
  'online',
  'dev',
  'app',
])

/** The lists a fresh install shows before the operator changes anything. */
export const SHIPPED_STYLE_LISTS: StyleLists = Object.freeze({
  namingStyles: [...SHIPPED_NAMING_STYLES],
  tones: [...SHIPPED_TONES],
  endings: [...SHIPPED_OFFERED_ENDINGS],
  offeredEndings: [...SHIPPED_OFFERED_ENDINGS],
})

/** A project's style before the person picks anything. */
export function emptyStyleChoices(): StyleChoiceValues {
  return {
    namingStyle: '',
    tone: '',
    length: '',
    include: '',
    avoid: '',
    preferredEndings: [],
  }
}

const OPTION_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const ENDING = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** A bare lower-case ending, with no leading dot, or null when it is not one. */
export function normalizeEnding(value: string): string | null {
  const ending = value.trim().toLowerCase().replace(/^\.+/, '')
  return ENDING.test(ending) ? ending : null
}

/** A stable option id the form can save, or null when it is not one. */
export function normalizeOptionId(value: string): string | null {
  const id = value.trim().toLowerCase()
  return OPTION_ID.test(id) ? id : null
}

/** A clean ending list: bare, lower-case, de-duplicated and still in order. */
export function normalizeEndingList(values: readonly string[]): string[] {
  const endings: string[] = []
  for (const value of values) {
    const ending = normalizeEnding(value)
    if (ending !== null && !endings.includes(ending)) endings.push(ending)
  }
  return endings
}

/** Keep only endings that pass DomainCheck.offeredEndings. */
export function filterEndingPicks(
  picks: readonly string[],
  offeredEndings: readonly string[],
): string[] {
  const offered = new Set(normalizeEndingList(offeredEndings))
  return normalizeEndingList(picks).filter((ending) => offered.has(ending))
}

/**
 * Split saved preferred endings into the ones the ending list still offers
 * and the ones it no longer does. A removed pick stops being offered, but an
 * existing project keeps the style it already holds.
 */
export function splitEndingPicks(
  picks: readonly string[],
  offeredEndings: readonly string[],
): { offered: string[]; unoffered: string[] } {
  const offered = new Set(normalizeEndingList(offeredEndings))
  const offeredPicks: string[] = []
  const unoffered: string[] = []
  for (const ending of normalizeEndingList(picks)) {
    if (offered.has(ending)) offeredPicks.push(ending)
    else unoffered.push(ending)
  }
  return { offered: offeredPicks, unoffered }
}

/** True when no style has been chosen at all. */
export function isStyleEmpty(style: StyleChoiceValues): boolean {
  return (
    style.namingStyle.trim().length === 0 &&
    style.tone.trim().length === 0 &&
    style.length.trim().length === 0 &&
    style.include.trim().length === 0 &&
    style.avoid.trim().length === 0 &&
    style.preferredEndings.length === 0
  )
}

/** The label for a saved pick, or a plain marker when it is no longer offered. */
export function styleChoiceLabel(options: readonly StyleOption[], id: string): string {
  if (id.length === 0) return ''
  return options.find((option) => option.id === id)?.label ?? `${id} (no longer offered)`
}

/** The label for a fixed length pick, or the empty string for no preference. */
export function lengthChoiceLabel(id: string): string {
  if (id.length === 0) return ''
  return LENGTH_OPTIONS.find((option) => option.id === id)?.label ?? `${id} (no longer offered)`
}

/**
 * Read lists from an API or storage value. Returns null when the shape is
 * unusable, so the caller can fall back to the shipped lists. Endings are
 * always filtered to the offered set the response gives.
 */
export function coerceStyleLists(
  value: unknown,
  fallbackEndings: readonly string[] = SHIPPED_OFFERED_ENDINGS,
): StyleLists | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>

  const namingStyles = readOptions(record.namingStyles)
  const tones = readOptions(record.tones)
  const rawEndings = record.endings
  const rawOffered = record.offeredEndings
  if (namingStyles === null || tones === null || !Array.isArray(rawEndings)) return null

  const offered = normalizeEndingList(
    Array.isArray(rawOffered)
      ? rawOffered.filter((ending): ending is string => typeof ending === 'string')
      : fallbackEndings,
  )
  const endings = filterEndingPicks(
    rawEndings.filter((ending): ending is string => typeof ending === 'string'),
    offered,
  )

  return { namingStyles, tones, endings, offeredEndings: offered }
}

function readOptions(value: unknown): StyleOption[] | null {
  if (!Array.isArray(value)) return null
  const options: StyleOption[] = []
  let malformed = 0
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      malformed += 1
      continue
    }
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.label !== 'string') {
      malformed += 1
      continue
    }
    const id = normalizeOptionId(record.id)
    const label = record.label.trim()
    if (id === null || label.length === 0) {
      malformed += 1
      continue
    }
    if (!options.some((option) => option.id === id)) options.push({ id, label })
  }
  if (options.length === 0 && malformed > 0) return null
  return options
}

/**
 * The style and company inputs the model reads.
 *
 * Every free-text field stays a separate value. A caller sends this object as
 * data; it is never pasted onto an instruction. See Generation.untrustedInput.
 */
export interface GenerationData {
  description: string
  industry: string | null
  style: {
    namingStyle: string | null
    tone: string | null
    length: 'one-word' | 'two-words' | null
    include: string | null
    avoid: string | null
    preferredEndings: string[]
  }
}

/** Build the data a generation round gives the model. */
export function buildGenerationData(input: {
  description: string
  industry?: string
  style: StyleChoiceValues
}): GenerationData {
  const text = (value: string): string | null => (value.trim().length === 0 ? null : value)
  const length = input.style.length === 'one-word' || input.style.length === 'two-words' ? input.style.length : null

  return {
    description: input.description,
    industry: text(input.industry ?? ''),
    style: {
      namingStyle: text(input.style.namingStyle),
      tone: text(input.style.tone),
      length,
      include: text(input.style.include),
      avoid: text(input.style.avoid),
      preferredEndings: normalizeEndingList(input.style.preferredEndings),
    },
  }
}

/** True when two list sets say the same thing, so a render can be skipped. */
export function sameStyleLists(a: StyleLists, b: StyleLists): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
