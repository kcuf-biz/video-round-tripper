/**
 * What the captured element gets from ABOVE it: inherited text style, the ground it sits on,
 * and the root font size its `rem`s mean.
 *
 * The clone renders as the root of a document that contains none of its ancestors. Whatever it
 * inherited from them, or showed through from behind them, is simply not there — and none of it
 * errors. Found by use (#67): a real page, mounted on <body>, round-tripped in
 * black Times over the right ground, because `color` and `font-family` were set on body and body
 * is not in the captured subtree. The report said `missingFonts: 0`, which was true — no font
 * failed to load — and pointed its reader at a font-loading bug that did not exist.
 *
 * Not specific to a body mount, which is why this lives in capture and not in mount.ts: a React
 * <RoundTrip> inside a styled <main> loses exactly the same things. So the clone is wrapped in
 * a stand-in for its parent, carrying:
 *
 *  - the parent's computed INHERITED properties (the typographic set and friends), which the
 *    clone root then inherits exactly as it would have from the real parent. An animation on an
 *    ancestor that moves `color` or `font-size` is covered by the same read — it was listed as
 *    an open gap under the animations pass;
 *  - the GROUND: the nearest ancestor background, including html/body's, which paint the
 *    viewport rather than their own box. That is what a real page's `body { background: <gradient> }`
 *    needed and never got. Below all of it the frame is filled with the page's own `Canvas`
 *    colour, which is what a browser shows through a page with no background at all — the
 *    scratch canvas used to leave that black;
 *  - `font-size` on the <svg> root, because `html { font-size: 62.5% }` does not match anything
 *    in the image document and every `rem` would silently resolve against 16px. (`:root` rules
 *    DO match the svg element, which is why this went unnoticed on pages written that way.)
 */

import type { ResourceCache } from './inlineResources.ts'
import type { CaptureReport } from './report.ts'
import { collectCssUrls, rewriteCssUrls } from './cssResources.ts'

/**
 * Inherited properties worth carrying. Everything here inherits by default, so on the wrapper it
 * behaves like the real parent; nothing here is laid out on the wrapper itself. `line-height`
 * is handled separately — see probe().
 */
const INHERITED = [
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-stretch',
  'font-variant',
  'font-feature-settings',
  'font-variation-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-synthesis',
  'font-size-adjust',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-indent',
  'text-transform',
  'text-shadow',
  'text-rendering',
  'text-underline-position',
  'text-decoration-skip-ink',
  'white-space-collapse',
  'text-wrap',
  'word-break',
  'overflow-wrap',
  'line-break',
  'hyphens',
  'tab-size',
  // `direction` yes, `writing-mode` no: a vertical wrapper would re-lay-out the clone's own box
  // along the other axis and misplace the whole frame, which is worse than the text inside it
  // coming out horizontal.
  'direction',
  'list-style-type',
  'list-style-position',
  'quotes',
  'border-collapse',
  'border-spacing',
  'caption-side',
  'empty-cells',
  'visibility',
  'color-scheme',
  'accent-color',
  'paint-order',
  'fill',
  'stroke',
  'stroke-width',
  'image-rendering',
  '-webkit-font-smoothing',
  '-webkit-text-stroke-width',
] as const

/*
 * Default to `currentcolor`, which getComputedStyle hands back RESOLVED. Carrying that pins
 * them to the parent's colour: every <input> — whose UA colour is fieldtext, not inherited —
 * then painted its text in the page's light body colour on a white field. So they are carried
 * only when they were actually set to something other than the colour itself.
 */
const CURRENTCOLOR_DEFAULTED = ['-webkit-text-fill-color', '-webkit-text-stroke-color'] as const

const BACKGROUND = [
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'background-repeat',
  'background-origin',
  'background-clip',
  'background-attachment',
  'background-blend-mode',
] as const

const transparent = (c: string) => !c || c === 'transparent' || /^rgba\([^)]*,\s*0\)$/.test(c)
const hasBackground = (cs: CSSStyleDeclaration) =>
  !transparent(cs.backgroundColor) || (cs.backgroundImage !== '' && cs.backgroundImage !== 'none')

const decl = (prop: string, value: string) => (value ? `${prop}:${value};` : '')

/*
 * Two facts need a probe element because computed style cannot say them: whether the parent's
 * line-height is a NUMBER (getComputedStyle reports it in px either way, measured: `1.5` at 20px
 * reads "30px", and carrying 30px would pin every larger heading below to 30px lines), and what
 * `Canvas` resolves to under the page's colour scheme. Both are memoised on what they depend on,
 * so the probe runs once per page rather than once per frame.
 */
interface Probed {
  key: string
  lineHeight: string
  canvas: string
}
const PROBED = new WeakMap<Element, Probed>()

function probe(parent: Element, cs: CSSStyleDeclaration): Probed {
  const key = `${cs.lineHeight}|${cs.fontSize}|${cs.colorScheme}`
  const memo = PROBED.get(parent)
  if (memo && memo.key === key) return memo

  const doc = parent.ownerDocument
  const span = doc.createElement('span')
  span.setAttribute('aria-hidden', 'true')
  span.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;font-size:100px;background-color:Canvas'
  parent.appendChild(span)
  const got = getComputedStyle(span)
  const probeLh = got.lineHeight
  const canvas = got.backgroundColor
  span.remove()

  let lineHeight = cs.lineHeight
  if (cs.lineHeight !== 'normal' && probeLh !== cs.lineHeight) {
    // It scaled with the probe's font-size, so what inherits is a factor, not a length.
    const n = parseFloat(probeLh) / 100
    if (Number.isFinite(n)) lineHeight = String(Math.round(n * 1000) / 1000)
  }
  const out = { key, lineHeight, canvas }
  PROBED.set(parent, out)
  return out
}

export interface AncestorContext {
  /** Inline style for the element standing in for the clone's parent. */
  wrapperStyle: string
  /** Inline style for the <svg> root. */
  rootStyle: string
  /** The page's own `Canvas` colour, painted under the frame. */
  ground: string
}

/** Computed `url("...")` values are absolute already; inline them like any other image. */
async function inlineBackgroundImage(
  value: string,
  base: string,
  cache: ResourceCache,
  report: CaptureReport,
): Promise<string> {
  if (!value.includes('url(')) return value
  const inlined = new Map<string, string>()
  await Promise.all(
    collectCssUrls(value, base).map(async (url) => {
      const data = await cache.resource(url)
      if (data !== null) inlined.set(url, data)
      else report.blockedImages++
    }),
  )
  return rewriteCssUrls(value, base, (abs) => inlined.get(abs) ?? null)
}

export async function snapshotAncestorContext(
  source: Element,
  cache: ResourceCache,
  report: CaptureReport,
): Promise<AncestorContext> {
  const doc = source.ownerDocument
  const view = doc.defaultView
  const html = doc.documentElement
  const parent = source.parentElement
  if (!view || !parent) return { wrapperStyle: '', rootStyle: '', ground: '' }

  const cs = view.getComputedStyle(parent)
  const probed = probe(parent, cs)

  let wrapper = ''
  for (const p of INHERITED) wrapper += decl(p, cs.getPropertyValue(p))
  for (const p of CURRENTCOLOR_DEFAULTED) {
    const v = cs.getPropertyValue(p)
    if (v !== cs.color) wrapper += decl(p, v)
  }
  wrapper += decl('line-height', probed.lineHeight)

  /*
   * The ground: the nearest ancestor that paints anything, carried onto the wrapper.
   *
   * Carried WHOLE — image, gradient, position, size — when it would land where it does live:
   *  - html, and body when html paints nothing: these propagate to the VIEWPORT canvas rather
   *    than painting their own box, and a mounted page no longer scrolls the document
   *    (.rt-content scrolls), so what sits behind the live content is that background pinned to
   *    the frame. Painting it on the wrapper reproduces exactly that;
   *  - any other ancestor (body included, once html has a background of its own and body
   *    therefore paints only its box) whose box is the capture's box, give or take a pixel —
   *    the body mount, or a <RoundTrip> that fills a styled section. Same box, same geometry.
   *
   * Otherwise its image would be positioned against a box the clone does not have. The colour
   * is still exact and is carried; the image is left out and COUNTED, not approximated silently.
   *
   * Getting the propagation rule wrong was measured on a real page, with its field moved from .stage
   * onto body: the first cut always took html's background when html had one, and the frame
   * came back flat maroon — html's colour — over a gradient that live filled the viewport.
   */
  const box = source.getBoundingClientRect()
  const sameBox = (a: Element) => {
    const r = a.getBoundingClientRect()
    return Math.abs(r.left - box.left) < 2 && Math.abs(r.top - box.top) < 2 &&
      Math.abs(r.width - box.width) < 2 && Math.abs(r.height - box.height) < 2
  }
  const carryWhole = async (from: CSSStyleDeclaration) => {
    for (const p of BACKGROUND) {
      let v = from.getPropertyValue(p)
      if (p === 'background-image') v = await inlineBackgroundImage(v, doc.baseURI, cache, report)
      wrapper += decl(p, v)
    }
  }
  const htmlPaints = hasBackground(view.getComputedStyle(html))
  for (let a: Element | null = parent; a; a = a.parentElement) {
    const acs = view.getComputedStyle(a)
    if (!hasBackground(acs)) continue
    const propagates = a === html || (a === doc.body && !htmlPaints)
    if (propagates || sameBox(a)) {
      await carryWhole(acs)
    } else {
      wrapper += decl('background-color', acs.backgroundColor)
      if (acs.backgroundImage !== 'none') report.ancestorBackgroundImages++
    }
    break
  }

  // The wrapper has to cover the frame for its ground to, whatever the clone's height says.
  wrapper += 'min-height:100%;'

  return {
    wrapperStyle: wrapper,
    rootStyle: decl('font-size', view.getComputedStyle(html).fontSize),
    ground: transparent(probed.canvas) ? '' : probed.canvas,
  }
}

/* --------------------------------------------------------------------- broken references */

const FRAGMENT_PROPS = ['fill', 'stroke', 'mask-image', 'filter', 'clip-path', 'marker-start', 'marker-mid', 'marker-end']
const FRAGMENT_URL = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/g

/**
 * Fragment references whose target is NOT in the captured subtree (#63's follow-on).
 *
 * With fragment urls left alone they resolve against the image document — correctly, when the
 * <linearGradient> or <filter> is inside the capture, and to nothing when it is not. The common
 * way to get the second: a <RoundTrip> around part of a page whose icon sprite or <defs> sits
 * higher up. SVG paints a missing paint server as `none`, so it is the same silent vanishing
 * #63 was, just with a different cause, and the report should say so.
 *
 * SVG elements only, to stay off the frame budget: one getComputedStyle per element is ~10ms
 * per thousand elements (measured under the pairing notes in ARCHITECTURE.md), so sweeping every HTML
 * element for a `filter: url(#f)` would cost a big page more than the rest of capture does.
 * The miss is an HTML element reaching an SVG filter/clip-path/mask through CSS — rare, and
 * named here rather than silently uncounted.
 */
export function countBrokenReferences(pairs: readonly { src: Element; dst: Element }[], clone: Element): number {
  let ids: Set<string> | null = null
  const exists = (id: string) => {
    if (!ids) {
      ids = new Set()
      if (clone.id) ids.add(clone.id)
      for (const el of Array.from(clone.querySelectorAll('[id]'))) ids.add(el.id)
    }
    return ids.has(id)
  }

  let broken = 0
  for (const { src } of pairs) {
    if (typeof SVGElement === 'undefined' || !(src instanceof SVGElement)) continue
    const href = src.getAttribute('href') ?? src.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    if (href && href.startsWith('#') && !exists(decodeURIComponent(href.slice(1)))) broken++
    const cs = getComputedStyle(src)
    for (const p of FRAGMENT_PROPS) {
      const v = cs.getPropertyValue(p)
      if (!v.includes('url(')) continue
      for (const m of v.matchAll(FRAGMENT_URL)) if (!exists(m[1]!)) broken++
    }
  }
  return broken
}
