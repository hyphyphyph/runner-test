// The one fixed rule that turns a name into a domain (DomainCheck.spelling).
// Lower case, spaces and punctuation removed, letters outside basic Latin
// transliterated or dropped, then the top level domain is added. The same
// name always gives the same domain.

export type Spelling =
  | { ok: true; label: string; domain: string }
  | { ok: false; reason: string }

// A domain label holds at most 63 characters.
export const MAX_LABEL = 63

// Letters that Unicode decomposition does not reduce to basic Latin.
const SPECIAL: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
  ŋ: 'n',
  ħ: 'h',
}

export function spellDomain(name: string, tld = 'com'): Spelling {
  const lowered = name.toLowerCase()
  let out = ''
  for (const ch of lowered) {
    if (SPECIAL[ch]) {
      out += SPECIAL[ch]
      continue
    }
    // Strip combining marks after decomposition: é becomes e.
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    for (const b of base) {
      if (/[a-z0-9]/.test(b)) out += b
    }
  }
  if (out.length === 0) {
    return {
      ok: false,
      reason:
        'Nothing is left of this name once spaces, punctuation and letters outside the Latin alphabet are removed, so it cannot form a .' +
        tld +
        ' domain.',
    }
  }
  if (out.length > MAX_LABEL) {
    return {
      ok: false,
      reason: `This name is too long for a domain: it has ${out.length} letters and digits, and a .${tld} domain allows at most ${MAX_LABEL}.`,
    }
  }
  return { ok: true, label: out, domain: `${out}.${tld}` }
}
