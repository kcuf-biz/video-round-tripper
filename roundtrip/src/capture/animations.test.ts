import { describe, expect, it } from 'vitest'
import { collectKeyframeCustoms, keyframePropertyNames } from './animations.ts'

/**
 * getKeyframes() hands back the animation's bookkeeping mixed in with the properties it
 * animates, and nothing in the shape distinguishes them. Both failure modes are silent:
 * a property we miss stays frozen at t=0 in the video (the bug this pass exists to fix, back
 * again for one property), and a metadata key we let through becomes a bogus inline
 * declaration like `offset: 0` on the clone.
 *
 * The shapes below are what Chrome actually returns; only this name extraction is pure enough
 * to test here — the rest of animations.ts is getComputedStyle against a live document, and
 * jsdom would answer those wrongly rather than not at all.
 */

describe('keyframePropertyNames', () => {
  it('drops the ComputedKeyframe metadata keys', () => {
    expect(
      keyframePropertyNames([
        { offset: 0, computedOffset: 0, easing: 'linear', composite: 'auto', opacity: '0' },
      ]),
    ).toEqual(['opacity'])
  })

  it('kebab-cases camelCase property names', () => {
    expect(keyframePropertyNames([{ backgroundColor: 'rgb(0, 0, 0)', borderTopWidth: '1px' }])).toEqual([
      'background-color',
      'border-top-width',
    ])
  })

  it('leaves custom properties alone', () => {
    // The real-world case: a registered @property animated by name. Lowercasing or kebab-casing
    // `--gAngle` would produce a property that does not exist, and setProperty would no-op.
    expect(keyframePropertyNames([{ '--g-angle': '32deg', '--gAngle': '1' }])).toEqual([
      '--g-angle',
      '--gAngle',
    ])
  })

  it('unions across keyframes and keeps first-seen order', () => {
    // A `to`-only animation reports the implicit `from` as a keyframe carrying the property
    // with a null value; the property is animated either way, so the name still counts.
    expect(
      keyframePropertyNames([
        { offset: 0, transform: null, color: 'rgb(1, 2, 3)' },
        { offset: 1, color: 'rgb(4, 5, 6)', transform: 'rotate(90deg)' },
      ]),
    ).toEqual(['transform', 'color'])
  })

  it('is empty for an effect with no keyframes', () => {
    expect(keyframePropertyNames([])).toEqual([])
  })
})

/**
 * #97: the custom properties a CSS animation animates come off its @keyframes rule, because
 * getKeyframes() leaves them out. The CSSOM shapes below are plain objects with the fields
 * Chrome's rules carry (a CSSKeyframeRule has keyText and a style that enumerates `--r`).
 * Missing a name freezes that property in the video; an extra one is harmless.
 */
describe('collectKeyframeCustoms', () => {
  const style = (...names: string[]) => Object.assign([...names], { length: names.length })
  const keyframes = (name: string, ...frames: string[][]) => ({
    name,
    cssRules: frames.map((names, i) => ({ keyText: `${i * 100}%`, style: style(...names) })),
  })
  const names = (rules: object[]) =>
    Object.fromEntries([...collectKeyframeCustoms(rules)].map(([k, v]) => [k, [...v].sort()]))

  it('takes only the custom properties, from every keyframe', () => {
    expect(names([keyframes('turn', ['--a', 'transform'], ['--b', 'opacity'])])).toEqual({ turn: ['--a', '--b'] })
  })

  it('records a keyframes rule that animates no custom property, so it is known, not a miss', () => {
    expect(names([keyframes('fade', ['opacity'])])).toEqual({ fade: [] })
  })

  it('recurses into grouping rules, and does not mistake @layer for @keyframes', () => {
    const layer = { name: 'base', cssRules: [{ cssRules: [keyframes('spin', ['--r'])] }, { selectorText: '.x', style: style('--z') }] }
    expect(names([layer])).toEqual({ spin: ['--r'] })
  })

  it('follows an @import, and skips one whose sheet it may not read', () => {
    const readable = { styleSheet: { cssRules: [keyframes('a', ['--a'])] } }
    // What Chrome does: the imported sheet is there, reading its rules throws SecurityError.
    const crossOrigin = {
      styleSheet: {
        get cssRules(): never {
          throw new DOMException('cross-origin', 'SecurityError')
        },
      },
    }
    expect(names([crossOrigin, readable])).toEqual({ a: ['--a'] })
  })

  it('unions same-named rules rather than letting the last one win', () => {
    expect(names([keyframes('k', ['--a']), keyframes('k', ['--b'])])).toEqual({ k: ['--a', '--b'] })
  })
})
