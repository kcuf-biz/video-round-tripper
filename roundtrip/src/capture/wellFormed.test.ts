import { describe, expect, it } from 'vitest'
import { escapeCdata, isXmlAttributeName, stripInvalidXmlChars } from './wellFormed.ts'

/**
 * The string half of the well-formedness pass. Each case here was checked against Chrome's
 * own SVG image decoder: the rejected ones lose the ENTIRE frame, not just their node.
 */

describe('isXmlAttributeName', () => {
  it('accepts ordinary HTML, data-, aria- and hyphenated names', () => {
    for (const n of ['class', 'data-x', 'aria-label', 'x-cloak', 'viewBox', 'hx-get', '_a', 'a.b']) {
      expect(isXmlAttributeName(n), n).toBe(true)
    }
  })

  it('rejects the framework directive names that left kcuf-style pages with no frames', () => {
    for (const n of ['@click', ':class', 'x-on:click', 'hx-on:click', 'v-on:click', '#ref', '1a', '']) {
      expect(isXmlAttributeName(n), n).toBe(false)
    }
  })
})

describe('stripInvalidXmlChars', () => {
  it('removes C0 controls but keeps tab, newline and carriage return', () => {
    expect(stripInvalidXmlChars('a\u0001b\u000Bc\td\ne\rf')).toBe('abc\td\ne\rf')
  })
})

describe('escapeCdata', () => {
  it('splits every terminator, which is legal inside a CSS string and fatal inside CDATA', () => {
    const out = escapeCdata('a{content:"]]>"}b{content:"]]>"}')
    expect(out).toBe('a{content:"]]]]><![CDATA[>"}b{content:"]]]]><![CDATA[>"}')
    // Reassembled the way an XML parser would, the text is unchanged.
    expect(`<![CDATA[${out}]]>`.replace(/]]><!\[CDATA\[/g, '').slice(9, -3)).toBe('a{content:"]]>"}b{content:"]]>"}')
  })
})
