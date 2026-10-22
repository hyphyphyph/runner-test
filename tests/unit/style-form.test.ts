import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emptyStyleChoices } from '../../shared/style.ts'
import type { StyleLists } from '../../shared/style.ts'
import {
  renderStyleForm,
  renderStyleSummary,
  STYLE_FORM_FIELDS,
  stylePatchFromField,
  styleSummaryRows,
  togglePreferredEnding,
} from '../../src/style-form.ts'

function lists(overrides: Partial<StyleLists> = {}): StyleLists {
  return {
    namingStyles: [
      { id: 'descriptive', label: 'Descriptive' },
      { id: 'invented', label: 'Invented' },
      { id: 'geographic', label: 'Geographic' },
    ],
    tones: [
      { id: 'playful', label: 'Playful' },
      { id: 'serious', label: 'Serious' },
    ],
    endings: ['com', 'io', 'studio'],
    offeredEndings: ['com', 'io', 'studio', 'design'],
    ...overrides,
  }
}

function style(overrides: Partial<ReturnType<typeof emptyStyleChoices>> = {}) {
  return { ...emptyStyleChoices(), ...overrides }
}

describe('the six-field style form', () => {
  test('it shows exactly the six fields from the specification', () => {
    const html = renderStyleForm(style(), lists())

    for (const field of STYLE_FORM_FIELDS) {
      assert.match(html, new RegExp(`data-field="${field}"`), `missing ${field}`)
    }
    assert.equal(STYLE_FORM_FIELDS.length, 6)
    assert.match(html, /data-field="style\.preferredEndings"/)
  })

  test('every field starts empty and no preference is checked', () => {
    const html = renderStyleForm(style(), lists())

    assert.equal((html.match(/>No preference<\/option>/g) ?? []).length, 3)
    assert.doesNotMatch(html, /\schecked/)
    assert.match(html, /value=""/)
    assert.match(html, /Leave them empty and the next round runs on the description alone/)
  })

  test('the picks come from the operator lists', () => {
    const html = renderStyleForm(style({ namingStyle: 'geographic', tone: 'serious' }), lists())

    assert.match(html, />Geographic<\/option>/)
    assert.match(html, />Serious<\/option>/)
    assert.match(html, /value="geographic" selected/)
    assert.match(html, /value="serious" selected/)
    assert.doesNotMatch(html, /value="evocative"/)
  })

  test('the ending boxes are filtered to offered endings', () => {
    const html = renderStyleForm(style(), lists({ endings: ['com', 'io'] }))

    assert.match(html, /data-ending="com"/)
    assert.match(html, /data-ending="io"/)
    assert.doesNotMatch(html, /data-ending="studio"/)
    assert.doesNotMatch(html, /data-ending="design"/)
  })

  test('a saved choice that is no longer offered is shown and kept', () => {
    const html = renderStyleForm(style({ namingStyle: 'evocative', preferredEndings: ['com', 'design'] }), lists())

    assert.match(html, /value="evocative" selected>evocative \(no longer offered\)<\/option>/)
    assert.match(html, /data-ending="com"[\s\S]*?checked/)
    assert.match(html, /Saved endings that are no longer offered stay with this project:/)
    assert.match(html, /\.design/)
  })

  test('free text is escaped and saved as its own value', () => {
    const html = renderStyleForm(
      style({ include: '<script>alert("x")</script>', avoid: 'competitor "A"' }),
      lists(),
    )

    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/)
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /competitor &quot;A&quot;/)
  })

  test('preferred endings are checkboxes, not a free-text field', () => {
    const html = renderStyleForm(style(), lists())
    assert.match(html, /type="checkbox"[\s\S]*?data-field="style.preferredEndings"/)
    assert.match(html, /never ticks or checks a pair/)
  })

  test('the form shows no more than six fields', () => {
    const html = renderStyleForm(style(), lists())
    const fields = new Set(html.match(/data-field="[^"]+"/g) ?? [])
    assert.equal(fields.size, 6)
  })
})

describe('the chosen style summary', () => {
  test('an empty style says the round runs on the description alone', () => {
    const html = renderStyleSummary(style(), lists())
    assert.match(html, /No style chosen/)
    assert.match(html, /description alone/)
    assert.match(html, /is-empty/)
  })

  test('it names each chosen field in words above the candidates', () => {
    const chosen = style({
      namingStyle: 'invented',
      tone: 'playful',
      length: 'two-words',
      include: 'light',
      avoid: 'old names',
      preferredEndings: ['com', 'io'],
    })
    const rows = styleSummaryRows(chosen, lists())
    assert.deepEqual(rows, [
      { label: 'Naming style', value: 'Invented' },
      { label: 'Tone', value: 'Playful' },
      { label: 'Length', value: 'Two words' },
      { label: 'Include', value: 'light' },
      { label: 'Avoid', value: 'old names' },
      { label: 'Preferred endings', value: '.com, .io' },
    ])

    const html = renderStyleSummary(chosen, lists())
    assert.match(html, /Style for the next round/)
    assert.match(html, /This applies to the next round only|A style change applies to the next round only/)
  })

  test('a preference that is no longer offered is marked, not silently dropped', () => {
    const rows = styleSummaryRows(style({ preferredEndings: ['com', 'design'] }), lists())
    assert.deepEqual(rows, [{ label: 'Preferred endings', value: '.com, .design (no longer offered)' }])
  })
})

describe('style form changes', () => {
  test('the pick and free-text fields patch one value each', () => {
    assert.deepEqual(stylePatchFromField('style.namingStyle', 'invented'), { namingStyle: 'invented' })
    assert.deepEqual(stylePatchFromField('style.tone', 'playful'), { tone: 'playful' })
    assert.deepEqual(stylePatchFromField('style.length', 'one-word'), { length: 'one-word' })
    assert.deepEqual(stylePatchFromField('style.include', 'light'), { include: 'light' })
    assert.deepEqual(stylePatchFromField('style.avoid', 'old'), { avoid: 'old' })
    assert.equal(stylePatchFromField('style.preferredEndings', 'com'), null)
    assert.equal(stylePatchFromField('description', 'text'), null)
  })

  test('ticking an ending changes the preference only', () => {
    assert.deepEqual(togglePreferredEnding(['com'], 'io', true), ['com', 'io'])
    assert.deepEqual(togglePreferredEnding(['com', 'io'], 'io', false), ['com'])
    assert.deepEqual(togglePreferredEnding(['com'], 'com', true), ['com'])
    assert.deepEqual(togglePreferredEnding([], 'io', false), [])
  })
})
