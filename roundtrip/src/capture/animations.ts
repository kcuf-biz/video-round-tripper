/**
 * Motion that lives in the CSS engine rather than in the markup.
 *
 * THE PROBLEM. Capture serializes the clone into an SVG and loads it through `new Image()`.
 * That SVG is a separate document with its OWN animation timeline, and a new one is built for
 * every single frame — so its timeline is always at t=0. A CSS keyframe animation therefore
 * renders at its first keyframe forever: perfect in the live DOM, which nobody ever sees, and
 * frozen in the video, which is all anyone sees. Measured before this file existed: two
 * captures 650ms apart differed by 58.4% of pixels for a JS-driven gradient and 0.0% for the
 * same motion expressed as CSS keyframes.
 *
 * THE FIX IS A SNAPSHOT, NOT A REPLAY. Nothing can make the SVG's timeline agree with the
 * host page's, so instead the CURRENT computed value of everything the animation touches is
 * written onto the clone as an inline style and the animation itself is switched off there.
 * The clone then carries a still of this instant, which is exactly what a frame is.
 *
 * TWO PASSES, because there are two ways animation reaches a pixel and only one of them has
 * the animated element in the captured subtree at all:
 *
 *  1. snapshotInheritedCustomProperties — the page animates registered @property custom
 *     properties on `:root` and a descendant consumes them through var(). This is the shape
 *     of every real page that does this (~/code/kcuf is thirteen such animations feeding one
 *     `--field` gradient). The animated element — <html> — is OUTSIDE the captured subtree, so
 *     no per-element pass can ever see it, and the clone inherits nothing because it is the
 *     root of its own document.
 *
 *     MEASURED, and the measurement decided the design: on that page, setting only the
 *     animated INPUTS (`--g-angle` and friends) on the capture root changes the captured
 *     frame by 0.00/255, while setting all of the root's computed custom properties changes
 *     it by 44.84/255. The reason is that var() substitution happens at computed-value time
 *     ON `:root`, so the descendants never see the inputs — they inherit the already-resolved
 *     `--field`. SNAPSHOT RESOLVED VALUES, NOT INPUTS.
 *
 *     Re-measured through the IIFE once this pass existed: 20 custom properties reach
 *     `.rt-content` there, and two grabs of the real page at two animation times differ by
 *     74.57/255 over the whole 1400x813 frame, against 0.00 for two grabs at the same time.
 *
 *  2. freezeAnimations — animations and transitions whose target IS inside the subtree.
 *     Those the clone does carry, as running animations that will restart at t=0, so each one
 *     has its properties pinned inline and is then turned off.
 *
 * WHAT IS STILL NOT COVERED, because neither pass can reach it: an animation on an ancestor
 * ABOVE the captured subtree that animates a non-custom inheritable property (`color`,
 * `font-size`, `visibility`) — pass 1 only carries custom properties, and pass 2 only visits
 * paired elements. A Web Animation whose effect is not a KeyframeEffect, or whose target is a
 * pseudo-element (`::before`), is skipped: there is no inline style to write it to.
 */

import type { ElementPair } from './pairs.ts'

/**
 * Keys a ComputedKeyframe carries that are NOT CSS properties.
 *
 * getKeyframes() returns the animation's own bookkeeping mixed in with the properties it
 * animates, and there is no flag distinguishing them — the only way to tell is to know the
 * reserved names. `cssText`/`cssOffset` are not in Chrome's output but are in the spec's
 * BasePropertyIndexedKeyframe, so they are excluded too rather than becoming a bogus
 * setProperty('css-text') call.
 */
const KEYFRAME_METADATA = new Set(['offset', 'computedOffset', 'easing', 'composite', 'cssText', 'cssOffset'])

/** camelCase -> kebab-case, leaving custom properties (`--x`) and already-kebab names alone. */
function cssName(key: string): string {
  if (key.startsWith('--')) return key
  return key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
}

/**
 * The CSS property names a set of computed keyframes animates, in first-seen order.
 *
 * Pure, and unit-tested, because it is the one piece of this file that can be: the rest is
 * getComputedStyle against a live document, which jsdom would answer wrongly rather than not
 * at all. Getting this wrong is silent in both directions — a missed property stays frozen at
 * t=0, a spurious one writes `offset: 0` or `easing: linear` into the clone's inline style.
 */
export function keyframePropertyNames(frames: readonly Record<string, unknown>[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const frame of frames) {
    for (const key of Object.keys(frame)) {
      if (KEYFRAME_METADATA.has(key)) continue
      // An absent property in one keyframe of a partial-keyframe animation comes back as
      // null/undefined; the property is still animated, it is just implicit here.
      const name = cssName(key)
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * Every custom property computed on the source root, set inline on the clone root.
 *
 * SAFE TO DO UNCONDITIONALLY, which is why there is no filtering: an inline declaration on the
 * clone root only sets the INHERITED value for the subtree. Any descendant that declares the
 * same property on itself still wins on itself, exactly as it does in the live document —
 * that is ordinary inheritance, not an override. The only thing this changes is the value
 * descendants inherit when they declare nothing, and the live value is by definition the right
 * one for that.
 *
 * Enumerating a computed style by index yields custom properties in Chrome (118+) and not in
 * every engine; where it does not, this degrades to setting nothing, which is the behaviour
 * that existed before this pass.
 *
 * COST, measured on the hostile page (14 custom properties reaching .rt-content, 1400x813):
 * 0.200ms median, 0.500ms p95, against a 27.8ms grab of that page — under 1%. It is a
 * per-frame cost and cannot be cached: the animated values are the entire reason to read
 * them, and a cached one is the frozen frame this pass exists to prevent.
 */
export function snapshotInheritedCustomProperties(source: Element, clone: Element): void {
  if (!(clone instanceof HTMLElement) && !(clone instanceof SVGElement)) return
  const cs = getComputedStyle(source)
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i]!
    if (!name.startsWith('--')) continue
    const value = cs.getPropertyValue(name)
    if (value === '') continue
    clone.style.setProperty(name, value)
  }
}

/** Running animations and transitions of the document, grouped by the element they target. */
export type AnimationIndex = Map<Element, Animation[]>

/**
 * ONE getAnimations() CALL FOR THE WHOLE CAPTURE.
 *
 * Element.getAnimations() would be the obvious per-element read and it is the wrong shape
 * here: it walks the document's animation list per call, so the work scales with paired
 * elements x animations rather than with animations. One document-level read and a Map costs
 * the walk once. NOT a measured win at the sizes tested — over the hostile page's 57 paired
 * elements and 5 animations both forms come out under the 0.1ms timer floor — so this is a
 * shape choice, not an optimisation, and the honest claim is that it does not degrade.
 *
 * Document.getAnimations() does NOT reach into shadow trees. This comment used to say it did,
 * and the shadow-root specimen froze in the video while it moved live (#74, the author at a real
 * screen). Measured on /hostile/: the document reported 6 animations, 0 of them in a shadow
 * tree, while the specimen's own bar reported 2 running. Each open shadow root has to be asked
 * itself — see addShadowAnimations, which prepareClone calls as the passes reach each root.
 */
export function indexAnimationsByTarget(doc: Document): AnimationIndex {
  const index: AnimationIndex = new Map()
  // Both guards are for non-browser hosts (SSR, a test runner): `instanceof KeyframeEffect`
  // is a ReferenceError, not false, where the constructor does not exist.
  if (typeof doc.getAnimations !== 'function' || typeof KeyframeEffect === 'undefined') return index
  addAnimations(index, doc.getAnimations())
  return index
}

/** Fold an open shadow root's own animations into the index, before its pairs are frozen. */
export function addShadowAnimations(index: AnimationIndex, root: ShadowRoot): void {
  if (typeof root.getAnimations !== 'function' || typeof KeyframeEffect === 'undefined') return
  addAnimations(index, root.getAnimations())
}

function addAnimations(index: AnimationIndex, all: Animation[]): void {
  for (const anim of all) {
    const effect = anim.effect
    // Not a KeyframeEffect (no getKeyframes), or targeting a pseudo-element we cannot write an
    // inline style to. Either way there is nothing this pass can pin.
    if (!(effect instanceof KeyframeEffect)) continue
    if (effect.pseudoElement) continue
    const target = effect.target
    if (!target) continue
    const hit = index.get(target)
    if (hit) {
      if (!hit.includes(anim)) hit.push(anim)
    } else index.set(target, [anim])
  }
}

/**
 * Something with a rule list: a stylesheet, or a rule that nests others. Duck-typed on purpose
 * so collectKeyframeCustoms can be tested with plain objects (jsdom's CSSOM is not Chrome's).
 */
interface RuleLike {
  readonly name?: unknown
  readonly keyText?: unknown
  readonly cssRules?: ArrayLike<RuleLike>
  readonly style?: ArrayLike<string>
  readonly styleSheet?: { readonly cssRules: ArrayLike<RuleLike> } | null
}

/** Custom property names each `@keyframes` rule declares, by animation name. */
export type KeyframeCustoms = Map<string, Set<string>>

/**
 * Walk a rule list for `@keyframes` and record which custom properties each one animates.
 *
 * A keyframes rule is recognised by its children carrying `keyText`, not by its own shape:
 * `@layer foo { ... }` also has a `name` and `cssRules`. Grouping rules (@media, @supports,
 * @layer, @container, nested style rules) are recursed into, and so is an @import's sheet.
 * Same-named rules are UNIONED rather than cascaded: an extra name only costs pinning one
 * property at the value it already has, while a missing one is the frozen-property bug.
 */
export function collectKeyframeCustoms(rules: ArrayLike<RuleLike>, into: KeyframeCustoms = new Map()): KeyframeCustoms {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    if (rule.styleSheet) {
      try {
        collectKeyframeCustoms(rule.styleSheet.cssRules, into)
      } catch {
        // A cross-origin import: its keyframes stay unknown, and their animations pin everything.
      }
    }
    const kids = rule.cssRules
    if (!kids || kids.length === 0) continue
    if (typeof rule.name === 'string' && kids[0]!.keyText !== undefined) {
      let names = into.get(rule.name)
      if (!names) into.set(rule.name, (names = new Set()))
      for (let k = 0; k < kids.length; k++) {
        const style = kids[k]!.style
        if (!style) continue
        for (let j = 0; j < style.length; j++) if (style[j]!.startsWith('--')) names.add(style[j]!)
      }
    } else collectKeyframeCustoms(kids, into)
  }
  return into
}

/**
 * The custom properties a CSS animation animates, or null when its @keyframes cannot be read.
 *
 * WHY THIS EXISTS: getKeyframes() leaves custom properties out of a CSSAnimation's keyframes —
 * registered or not, and alone or alongside ordinary properties. Probed in Chrome 151:
 * `@keyframes { to { --r: 90deg; transform: rotate(10deg) } }` reports `transform` only, and a
 * custom-property-only animation reports empty keyframes. A CSSTransition of `--r` and an
 * element.animate() of `--r` both DO report it, so only CSS animations need this. The rule
 * itself still has them: a CSSKeyframeRule's `style` enumerates `--r`.
 *
 * Lazy and per capture: the sheets are only walked the first time an animated element inside
 * the subtree turns out to run a CSS animation, once per tree scope (the document, and each
 * shadow root, whose own @keyframes take precedence for elements inside it). Not cached across
 * frames, so a keyframes rule added by insertRule is seen on the next frame.
 */
export function createKeyframeCustomsLookup(): (animationName: string, target: Element) => ReadonlySet<string> | null {
  const scopes = new Map<Document | ShadowRoot, KeyframeCustoms>()
  const customsOf = (scope: Document | ShadowRoot): KeyframeCustoms => {
    let found = scopes.get(scope)
    if (found) return found
    found = new Map()
    for (const sheet of [...scope.styleSheets, ...(scope.adoptedStyleSheets ?? [])]) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        continue // cross-origin without CORS: unreadable, so its animations fall back to pinning all
      }
      collectKeyframeCustoms(rules as unknown as ArrayLike<RuleLike>, found)
    }
    scopes.set(scope, found)
    return found
  }
  return (animationName, target) => {
    let node: Node = target.getRootNode()
    for (;;) {
      if (node instanceof ShadowRoot || node instanceof Document) {
        const hit = customsOf(node).get(animationName)
        if (hit) return hit
      }
      if (!(node instanceof ShadowRoot)) return null
      node = node.host.getRootNode()
    }
  }
}

/**
 * Pin every animated property to its current computed value on the clone, then stop the clone
 * animating at all.
 *
 * RUNS BEFORE positioning, and that order is load-bearing: positioning writes a composed
 * `translate(...) <the source's computed transform>` onto the clone, and this pass writes the
 * bare animated transform. Freezing second would overwrite the composed value and silently
 * drop the scroll offset of every animated element inside a scroller.
 *
 * `animation: none; transition: none` is not belt-and-braces: without it the clone's own
 * timeline restarts at t=0 in the SVG document and the cascade puts the animation's t=0 value
 * back on top of the inline declaration we just wrote, because a running animation wins over
 * inline style. The inline value only sticks once nothing is animating it.
 *
 * Transitions come through the same door — a CSSTransition's effect is a KeyframeEffect whose
 * keyframes name the transitioning property — so mid-transition state is captured as the
 * in-between value it currently has, rather than snapping to the end value.
 *
 * `customsOf` is per capture; prepareClone makes one and shares it across shadow recursion.
 */
export function freezeAnimations(
  pairs: readonly ElementPair[],
  index: AnimationIndex,
  customsOf: ReturnType<typeof createKeyframeCustomsLookup> = createKeyframeCustomsLookup(),
): void {
  if (index.size === 0) return
  const hasCssAnimation = typeof CSSAnimation !== 'undefined'
  for (const pair of pairs) {
    const anims = index.get(pair.src)
    if (!anims) continue
    const d = pair.dst
    if (!(d instanceof HTMLElement) && !(d instanceof SVGElement)) continue

    const pin = (name: string) => {
      const value = pair.cs.getPropertyValue(name)
      if (value !== '') d.style.setProperty(name, value)
    }
    let pinAllCustoms = false
    for (const anim of anims) {
      const effect = anim.effect as KeyframeEffect
      for (const name of keyframePropertyNames(effect.getKeyframes() as unknown as Record<string, unknown>[])) pin(name)
      /*
       * CUSTOM PROPERTIES ARE MISSING FROM getKeyframes() for a CSS animation (see
       * createKeyframeCustomsLookup), so the loop above never sees `--sway` or `--g3`, and the
       * clone froze them at their initial value while everything else moved: the marketing
       * page's background stops read 0.00 mean diff across a 40s seek in the video against
       * 9.73 live, and its rainbows' angle sway had never moved in the video at all (the author,
       * 2026-10-03). So they are read off the animation's own @keyframes rule instead.
       */
      if (!hasCssAnimation || !(anim instanceof CSSAnimation)) continue
      const customs = customsOf(anim.animationName, pair.src)
      if (customs) for (const name of customs) pin(name)
      else pinAllCustoms = true
    }
    /*
     * The fallback, when the @keyframes rule could not be read (a cross-origin sheet, a scope
     * the lookup does not reach): every custom property on the element, at its live computed
     * value. Always correct, since it is exactly what the element has right now, but it was
     * the unconditional behaviour until #97 measured it: on the marketing page it pinned 325
     * properties across 18 animated elements, nearly all of them inherited design tokens,
     * for +2-3ms median per grab and +8.5KB of markup. See notes/97-pin-cost.md.
     */
    if (pinAllCustoms) {
      for (let i = 0; i < pair.cs.length; i++) {
        const name = pair.cs[i]!
        if (name.startsWith('--')) pin(name)
      }
    }

    d.style.setProperty('animation', 'none')
    d.style.setProperty('transition', 'none')
  }
}
