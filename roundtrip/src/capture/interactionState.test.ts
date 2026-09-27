import { describe, expect, it } from 'vitest'
import { rewriteStateRules, rewriteStateSelector } from './interactionState.ts'

/**
 * The text half of carrying :hover/:active/:focus into the clone (#68). A mistake here does not
 * throw: a state rule silently never matches, or a media query silently starts matching
 * attributes that do not exist.
 */

describe('rewriteStateSelector', () => {
  it('maps each state to its attribute', () => {
    expect(rewriteStateSelector('.b:hover')).toBe('.b[data-rt-hover]')
    expect(rewriteStateSelector('.b:active')).toBe('.b[data-rt-active]')
    expect(rewriteStateSelector('input:focus')).toBe('input[data-rt-focus]')
    expect(rewriteStateSelector('a:focus-visible')).toBe('a[data-rt-focus-visible]')
    expect(rewriteStateSelector('.f:focus-within label')).toBe('.f[data-rt-focus-within] label')
  })

  it('handles lists, chains, functional pseudo-classes and case', () => {
    expect(rewriteStateSelector('a:hover, b:focus')).toBe('a[data-rt-hover], b[data-rt-focus]')
    expect(rewriteStateSelector('a:hover:active')).toBe('a[data-rt-hover][data-rt-active]')
    expect(rewriteStateSelector('a:not(:hover)')).toBe('a:not([data-rt-hover])')
    expect(rewriteStateSelector(':is(a, b):HOVER')).toBe(':is(a, b)[data-rt-hover]')
  })

  it('leaves look-alikes and quoted text alone', () => {
    expect(rewriteStateSelector('a:hovered')).toBe('a:hovered')
    expect(rewriteStateSelector('a:active-thing')).toBe('a:active-thing')
    expect(rewriteStateSelector('[title=":hover"]')).toBe('[title=":hover"]')
    expect(rewriteStateSelector('a:visited')).toBe('a:visited')
  })
})

describe('rewriteStateRules', () => {
  it('rewrites selectors and never declarations', () => {
    const css = '.b:hover{content:":hover";background:url("x:hover.png")}'
    expect(rewriteStateRules(css)).toBe('.b[data-rt-hover]{content:":hover";background:url("x:hover.png")}')
  })

  it('leaves at-rule preludes alone, the (hover:hover) media feature above all', () => {
    const css = '@media (hover:hover){.b:hover{color:red}}@supports selector(:focus-visible){a:focus-visible{outline:0}}'
    expect(rewriteStateRules(css)).toBe(
      '@media (hover:hover){.b[data-rt-hover]{color:red}}@supports selector(:focus-visible){a[data-rt-focus-visible]{outline:0}}',
    )
  })

  it('reaches nested rules', () => {
    expect(rewriteStateRules('.b{color:red;&:hover{color:blue}}')).toBe('.b{color:red;&[data-rt-hover]{color:blue}}')
    expect(rewriteStateRules('.b{&:focus{x:y}}')).toBe('.b{&[data-rt-focus]{x:y}}')
  })

  it('is not thrown by an unquoted data: url whose ; is not a boundary', () => {
    const css = '.a{background:url(data:image/png;base64,AA{)}.b:hover{color:red}'
    expect(rewriteStateRules(css)).toBe('.a{background:url(data:image/png;base64,AA{)}.b[data-rt-hover]{color:red}')
  })

  it('skips comments', () => {
    expect(rewriteStateRules('/* a:hover{ */.b:hover{c:d}')).toBe('/* a:hover{ */.b[data-rt-hover]{c:d}')
    expect(rewriteStateRules('a/* x */:hover{c:d}')).toBe('a/* x */[data-rt-hover]{c:d}')
  })

  it('returns the input untouched when there is nothing to do', () => {
    const css = '.a{color:red}'
    expect(rewriteStateRules(css)).toBe(css)
  })
})
