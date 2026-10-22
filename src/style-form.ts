// The six-field style form and the summary above the candidate list.
//
// The form is plain HTML built from the operator's lists, so the page itself
// has no fixed set of styles. Every field starts empty and may stay empty.
// Preferred endings are checkboxes: checking one saves a preference, and
// nothing is ever ticked for a domain check from here.

import type { StyleLists, StyleOption } from '../shared/style.ts'
import {
  filterEndingPicks,
  isStyleEmpty,
  LENGTH_OPTIONS,
  lengthChoiceLabel,
  splitEndingPicks,
  styleChoiceLabel,
} from '../shared/style.ts'
import type { StyleChoices } from './local/types.ts'
import { escapeHtml } from './html.ts'

/** The six fields the form shows, in the order Generation.styleFields lists them. */
export const STYLE_FORM_FIELDS = [
  'style.namingStyle',
  'style.tone',
  'style.length',
  'style.include',
  'style.avoid',
  'style.preferredEndings',
] as const

/** One row of the chosen-style summary above the candidate list. */
export interface StyleSummaryRow {
  label: string
  value: string
}

function optionRows(options: readonly StyleOption[], selected: string): string {
  const rows = [`<option value=""${selected === '' ? ' selected' : ''}>No preference</option>`]
  if (selected !== '' && !options.some((option) => option.id === selected)) {
    rows.push(
      `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (no longer offered)</option>`,
    )
  }
  for (const option of options) {
    rows.push(
      `<option value="${escapeHtml(option.id)}"${option.id === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`,
    )
  }
  return rows.join('')
}

/**
 * The whole style card. The lists arrive from the operator through the API;
 * this function never invents a choice that is not in them.
 */
export function renderStyleForm(style: StyleChoices, lists: StyleLists): string {
  const { unoffered } = splitEndingPicks(style.preferredEndings, lists.endings)
  const endingChoices =
    lists.endings.length === 0
      ? `<p class="muted small">No endings are being offered right now. You can still run a round on the description alone.</p>`
      : `<div class="ending-choices">
          ${lists.endings
            .map(
              (ending) => `
                <label class="ending-choice">
                  <input
                    type="checkbox"
                    data-field="style.preferredEndings"
                    data-ending="${escapeHtml(ending)}"
                    ${style.preferredEndings.includes(ending) ? 'checked' : ''}
                  />
                  <span>.${escapeHtml(ending)}</span>
                </label>
              `,
            )
            .join('')}
        </div>`

  const legacyEndings =
    unoffered.length === 0
      ? ''
      : `<p class="field-hint">
          Saved endings that are no longer offered stay with this project:
          ${unoffered.map((ending) => `.${escapeHtml(ending)}`).join(', ')}.
          They are not a choice to check here.
        </p>`

  return `
    <section class="card style-card" aria-labelledby="style-heading">
      <div class="section-head">
        <div>
          <h2 id="style-heading">Style choices</h2>
          <p class="muted small">
            Every field is optional. Leave them empty and the next round runs on the description alone.
          </p>
        </div>
      </div>
      <div class="style-grid">
        <label>
          <span class="label-text">Naming style</span>
          <select data-field="style.namingStyle">${optionRows(lists.namingStyles, style.namingStyle)}</select>
        </label>
        <label>
          <span class="label-text">Tone</span>
          <select data-field="style.tone">${optionRows(lists.tones, style.tone)}</select>
        </label>
        <label>
          <span class="label-text">Length</span>
          <select data-field="style.length">${optionRows(LENGTH_OPTIONS, style.length)}</select>
        </label>
        <label>
          <span class="label-text">Things to include</span>
          <input
            data-field="style.include"
            type="text"
            value="${escapeHtml(style.include)}"
            placeholder="Words or sounds"
            autocomplete="off"
          />
          <span class="field-hint">Read as data, never as an instruction.</span>
        </label>
        <label>
          <span class="label-text">Things to avoid</span>
          <input
            data-field="style.avoid"
            type="text"
            value="${escapeHtml(style.avoid)}"
            placeholder="Words, sounds or competitors"
            autocomplete="off"
          />
          <span class="field-hint">Read as data, never as an instruction.</span>
        </label>
        <fieldset class="style-endings">
          <legend class="label-text">Preferred endings</legend>
          <p class="field-hint">
            A preference guides the endings the model suggests. It never ticks or checks a pair;
            you still choose what to check.
          </p>
          ${endingChoices}
          <p class="field-hint">Leave every box unticked for no preference.</p>
          ${legacyEndings}
        </fieldset>
      </div>
    </section>
  `
}

/** The chosen style, in words, for the area above the candidate list. */
export function styleSummaryRows(style: StyleChoices, lists: StyleLists): StyleSummaryRow[] {
  const rows: StyleSummaryRow[] = []
  if (style.namingStyle.length > 0) {
    rows.push({ label: 'Naming style', value: styleChoiceLabel(lists.namingStyles, style.namingStyle) })
  }
  if (style.tone.length > 0) {
    rows.push({ label: 'Tone', value: styleChoiceLabel(lists.tones, style.tone) })
  }
  if (style.length.length > 0) {
    rows.push({ label: 'Length', value: lengthChoiceLabel(style.length) })
  }
  if (style.include.trim().length > 0) {
    rows.push({ label: 'Include', value: style.include.trim() })
  }
  if (style.avoid.trim().length > 0) {
    rows.push({ label: 'Avoid', value: style.avoid.trim() })
  }

  const endings = splitEndingPicks(style.preferredEndings, lists.endings)
  const shown = [
    ...endings.offered.map((ending) => `.${ending}`),
    ...endings.unoffered.map((ending) => `.${ending} (no longer offered)`),
  ]
  if (shown.length > 0) {
    rows.push({ label: 'Preferred endings', value: shown.join(', ') })
  }

  return rows
}

/** The summary that sits above the candidate list. */
export function renderStyleSummary(style: StyleChoices, lists: StyleLists): string {
  const rows = styleSummaryRows(style, lists)
  const body =
    rows.length === 0
      ? `<p class="muted small">
          No style chosen. The next round runs on the description alone, and names already in the
          list keep their style.
        </p>`
      : `<dl class="style-summary-list">
          ${rows
            .map(
              (row) => `
                <div>
                  <dt>${escapeHtml(row.label)}</dt>
                  <dd>${escapeHtml(row.value)}</dd>
                </div>
              `,
            )
            .join('')}
        </dl>
        <p class="muted tiny">
          Names already in the list keep their style. A style change applies to the next round only.
        </p>`

  return `<div class="chosen-style${isStyleEmpty(style) ? ' is-empty' : ''}" data-style-summary>
      <span class="subhead">Style for the next round</span>
      ${body}
    </div>`
}

/** The style patch for one pick-list or free-text field, if it has one. */
export function stylePatchFromField(field: string, value: string): Partial<StyleChoices> | null {
  switch (field) {
    case 'style.namingStyle':
      return { namingStyle: value }
    case 'style.tone':
      return { tone: value }
    case 'style.length':
      return { length: value }
    case 'style.include':
      return { include: value }
    case 'style.avoid':
      return { avoid: value }
    default:
      return null
  }
}

/**
 * Check or untick one preferred ending. This changes only the style; it never
 * creates a pending check or a domain result.
 */
export function togglePreferredEnding(
  current: readonly string[],
  ending: string,
  checked: boolean,
): string[] {
  const next = [...current]
  if (checked) {
    if (!next.includes(ending)) next.push(ending)
  } else {
    const index = next.indexOf(ending)
    if (index >= 0) next.splice(index, 1)
  }
  return next
}

/** Keep only offered endings in a summary value, for a caller that wants it. */
export function offeredPreferredEndings(style: StyleChoices, lists: StyleLists): string[] {
  return filterEndingPicks(style.preferredEndings, lists.endings)
}
