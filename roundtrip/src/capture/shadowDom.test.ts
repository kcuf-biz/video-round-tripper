import { describe, expect, it } from 'vitest'
import { rewriteSelector, splitRuleText, splitSelectorList } from './shadowDom.ts'

/**
 * The shadow boundary cannot survive into the flat SVG document, so it is reproduced by
 * rewriting selectors. Getting this wrong does not throw: shadow rules simply start matching
 * the whole page, or stop matching anything.
 */

const H = '[data-rt-sh="3"]'

describe('splitSelectorList', () => {
  it('splits on top-level commas only', () => {
    expect(splitSelectorList('a, b')).toEqual(['a', 'b'])
  })

  it('does not split inside a functional pseudo-class', () => {
    expect(splitSelectorList(':is(a, b) c')).toEqual([':is(a, b) c'])
    expect(splitSelectorList(':not(.x, .y), p')).toEqual([':not(.x, .y)', 'p'])
  })

  it('does not split inside an attribute value', () => {
    expect(splitSelectorList('[title="a,b"], p')).toEqual(['[title="a,b"]', 'p'])
  })
})

describe('rewriteSelector', () => {
  it(':host becomes the host attribute selector', () => {
    expect(rewriteSelector(':host', H)).toBe(H)
  })

  it(':host(cond) concatenates, because the condition is a compound on the host itself', () => {
    expect(rewriteSelector(':host(.warm)', H)).toBe(`${H}.warm`)
    expect(rewriteSelector(':host(.warm) p', H)).toBe(`${H}.warm p`)
    // nested parens must not truncate at the first ')'
    expect(rewriteSelector(':host(:not(.a)) p', H)).toBe(`${H}:not(.a) p`)
  })

  it(':host-context(X) becomes a descendant of X, which is what it means in a flat tree', () => {
    expect(rewriteSelector(':host-context(.dark) p', H)).toBe(`.dark ${H} p`)
  })

  it('scopes an ordinary selector under the host', () => {
    expect(rewriteSelector('p', H)).toBe(`${H} p`)
    expect(rewriteSelector('.a > .b', H)).toBe(`${H} .a > .b`)
  })

  it('::slotted(X) collapses to X, since an assigned node sits where its slot was', () => {
    expect(rewriteSelector('::slotted(b)', H)).toBe(`${H} b`)
    expect(rewriteSelector('.wrap ::slotted(b.big)', H)).toBe(`${H} .wrap b.big`)
  })

  it('rewrites every selector in a list independently', () => {
    expect(rewriteSelector(':host, p, ::slotted(b)', H)).toBe(`${H}, ${H} p, ${H} b`)
  })

  it('does not mistake a selector that merely starts with the letters of :host', () => {
    expect(rewriteSelector(':hover', H)).toBe(`${H} :hover`)
  })
})

/**
 * #94: the authored text a lossy shadow rule falls back to. It is index-matched against a
 * constructed sheet's cssRules, so a miscount here hands a rule another rule's declarations.
 */
describe('splitRuleText', () => {
  it('splits top-level rules into prelude and block', () => {
    expect(splitRuleText('p { color: red } :host{display:block}')).toEqual([
      { prelude: 'p', body: ' color: red ' },
      { prelude: ':host', body: 'display:block' },
    ])
  })

  it('keeps a nested block whole', () => {
    const [media] = splitRuleText('@media (min-width: 1px) { p { a: b } q { c: d } }')
    expect(media!.prelude).toBe('@media (min-width: 1px)')
    expect(splitRuleText(media!.body!)).toEqual([
      { prelude: 'p', body: ' a: b ' },
      { prelude: 'q', body: ' c: d ' },
    ])
  })

  it('is not ended by a brace inside a string or a comment', () => {
    const rules = splitRuleText('p::before { content: "}" } /* } { */ q { a: b }')
    expect(rules.map((r) => r.prelude)).toEqual(['p::before', 'q'])
    expect(rules[0]!.body).toBe(' content: "}" ')
  })

  it('strips comments from the prelude', () => {
    expect(splitRuleText('/* head */ p /* x */ { a: b }')[0]!.prelude).toBe('p')
  })

  it('drops @import and @charset, which a constructed sheet drops too, and keeps other statements', () => {
    expect(splitRuleText('@charset "utf-8"; @import url(a.css); @layer x, y; p { a: b }')).toEqual([
      { prelude: '@layer x, y', body: null },
      { prelude: 'p', body: ' a: b ' },
    ])
  })

  it('keeps the var() shorthand the CSSOM loses', () => {
    const body = ' background: var(--s); background-size: 8px 8px; '
    expect(splitRuleText(`.b {${body}}`)[0]!.body).toBe(body)
  })
})
