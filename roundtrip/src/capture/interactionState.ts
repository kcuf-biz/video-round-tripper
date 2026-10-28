/**
 * :hover, :active and :focus, carried into the clone.
 *
 * The clone renders as an SVG image, and nothing in an image is hovered, pressed or focused —
 * those are live UA states, not markup — so every rule keyed on them simply never matched.
 * Found by use (#68): a real page's buttons highlighted in the live DOM, which
 * nobody sees under the canvas, and sat at rest in the video, which is all anyone sees. On a
 * component whose premise is that the page stays usable underneath, the visible page had no
 * interaction feedback at all.
 *
 * Same shape as the url() rewriting: state becomes an attribute on the clone, and the CSS is
 * rewritten to select the attribute.
 *
 *   :hover          -> [data-rt-hover]
 *   :active         -> [data-rt-active]
 *   :focus          -> [data-rt-focus]
 *   :focus-visible  -> [data-rt-focus-visible]
 *   :focus-within   -> [data-rt-focus-within]
 *
 * `data-rt-` and not `data-`: a page may already mirror states onto `data-hover` etc. by
 * hand, and must keep working unchanged alongside this.
 *
 * Still out of reach, by nature rather than by omission: the text caret and text selection,
 * which are not in the DOM at all.
 */

import type { ElementPair } from './pairs.ts'

const STATES = [
  // Longest first, so `:focus` never eats the front of `:focus-visible`.
  ['focus-visible', 'data-rt-focus-visible'],
  ['focus-within', 'data-rt-focus-within'],
  ['focus', 'data-rt-focus'],
  ['hover', 'data-rt-hover'],
  ['active', 'data-rt-active'],
] as const

const STATE_PC = /:(focus-visible|focus-within|focus|hover|active)(?![\w-])/gi
const ATTR_FOR = new Map<string, string>(STATES.map(([pc, attr]) => [pc, attr]))

/**
 * Rewrite the state pseudo-classes in ONE selector (list). Quote-aware, so `[title=":hover"]`
 * is left alone; `::` never precedes these names in valid CSS, but it is guarded anyway.
 */
export function rewriteStateSelector(selector: string): string {
  if (!/:(?:hover|active|focus)/i.test(selector)) return selector
  let out = ''
  let quote: string | null = null
  let last = 0
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c !== ':' || selector[i + 1] === ':' || selector[i - 1] === ':') continue
    STATE_PC.lastIndex = i
    const m = STATE_PC.exec(selector)
    if (!m || m.index !== i) continue
    out += selector.slice(last, i) + `[${ATTR_FOR.get(m[1]!.toLowerCase())}]`
    last = i + m[0].length
    i = last - 1
  }
  return out + selector.slice(last)
}

/**
 * Rewrite state pseudo-classes in a whole stylesheet's TEXT, touching selectors only.
 *
 * A regex over the sheet would also rewrite `@media (hover:hover)` — the media feature, which
 * the image document evaluates correctly on its own — and anything inside a string or a url().
 * So: a prelude is whatever sits between the previous `{`, `}` or `;` and the next `{`. A
 * prelude starting with `@` is an at-rule condition and left alone; any other prelude is a
 * selector, nested rules (`&:hover`) included. Strings and comments are skipped whole.
 *
 * Works the same on CSSOM `cssText` and on raw fetched text, which is why it is a text pass and
 * not a CSSOM walk: cross-origin sheets only exist here as text.
 */
export function rewriteStateRules(css: string): string {
  if (!/:(?:hover|active|focus)/i.test(css)) return css
  let out = ''
  let segStart = 0
  let emitted = 0
  let parens = 0
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!
    if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++) if (css[i] === '\\') i++
      continue
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
      // Restart the prelude past it: whatever preceded the comment is copied verbatim, and a
      // comment's contents are never a selector.
      if (parens === 0) segStart = i + 1
      continue
    }
    // An unquoted url(data:...;base64,...) carries a `;` that is not a declaration boundary.
    if (c === '(') parens++
    else if (c === ')') parens = Math.max(0, parens - 1)
    if (parens > 0) continue
    if (c === ';' || c === '}') {
      segStart = i + 1
    } else if (c === '{') {
      const prelude = css.slice(segStart, i)
      if (!prelude.trimStart().startsWith('@')) {
        const rewritten = rewriteStateSelector(prelude)
        if (rewritten !== prelude) {
          out += css.slice(emitted, segStart) + rewritten
          emitted = i
        }
      }
      segStart = i + 1
    }
  }
  return out + css.slice(emitted)
}

/**
 * The UA's own focus ring, restated for the attribute. The image document's UA sheet only knows
 * the real `:focus-visible`, which never matches there, so keyboard focus would otherwise land
 * with no ring at all. Emitted BEFORE the page's CSS: a page that removes the ring writes
 * `:focus-visible { outline: none }`, which becomes the same selector and wins by order.
 */
export const STATE_BASE_CSS =
  // Chromium's own UA rule, with a plain fallback first for engines that drop the keyword.
  '[data-rt-focus-visible]{outline:auto 1px;outline:-webkit-focus-ring-color auto 1px}\n'

const ANY_STATE = ':hover, :active, :focus, :focus-within'

/**
 * Stamp the live states onto the clone. One combined matches() per element, and the
 * individual checks only on the handful that pass it — usually the hover chain and the focus
 * chain, a dozen elements on a page of thousands.
 */
export function syncInteractionState(pairs: readonly ElementPair[]): void {
  for (const { src, dst } of pairs) {
    let any: boolean
    try {
      any = src.matches(ANY_STATE)
    } catch {
      return // an engine without :focus-within; nothing sensible to stamp
    }
    if (!any) continue
    if (src.matches(':hover')) dst.setAttribute('data-rt-hover', '')
    if (src.matches(':active')) dst.setAttribute('data-rt-active', '')
    if (src.matches(':focus')) {
      dst.setAttribute('data-rt-focus', '')
      try {
        if (src.matches(':focus-visible')) dst.setAttribute('data-rt-focus-visible', '')
      } catch {
        /* no :focus-visible: the ring simply is not drawn */
      }
    }
    if (src.matches(':focus-within')) dst.setAttribute('data-rt-focus-within', '')
  }
}
