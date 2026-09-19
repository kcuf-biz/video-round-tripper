/**
 * THE DROP-ANYWHERE SEAM — the entry point.
 *
 * Everything that separates "works on the page we authored" from "works on any page" lives in
 * this directory; this file is the composer. prepareClone() runs every pass over one
 * source/clone pair, in the one order that works, and createResourceCache() holds the bytes
 * they all share.
 *
 * Why this matters more than it looks: an <img>-loaded SVG is a SEPARATE DOCUMENT. It cannot
 * see the host page's stylesheets or fonts, and it is not allowed to fetch anything. Whatever
 * is not inlined here simply is not there. The spike measured the consequence — without font
 * inlining the demo heading silently rendered in Georgia instead of Fraunces and 32.9% of its
 * pixels differed. It does not error. It just quietly renders the wrong thing, which reads as
 * a broken website rather than as a codec artifact, i.e. it destroys the point of the piece.
 *
 * The passes, in `capture/`:
 *   cssResources.ts         every stylesheet's fonts and images, inlined as data: URIs
 *   replaceUnserializable.ts <img>/<canvas>/<video>/<iframe> — pixels that are not markup
 *   pairs.ts                the index-matched source/clone pairing they all work against
 */

import { collectCss, bytesToBase64, mimeFor } from './cssResources.ts'
import { pairElements, type ElementPair } from './pairs.ts'
import { replaceUnserializable } from './replaceUnserializable.ts'
import { emptyReport, type CaptureReport } from './report.ts'

/**
 * Cumulative across the cache's life, because the bytes are: a font that refused CORS on the
 * first frame is still refusing on the thousandth, and refetching it to find out would undo
 * the caching this whole file exists for.
 */
export interface ResourceStats {
  missingFonts: number
  blockedImages: number
  /** Total inlined payload, against BYTE_BUDGET. */
  bytes: number
}

export interface ResourceCache {
  /** The full stylesheet to embed in the SVG. Built once, reused every frame. */
  css(): Promise<string>
  /** Any fetchable resource as a data: URI, or null if it refused. One fetch per URL, ever. */
  resource(url: string): Promise<string | null>
  /** Raw text of a stylesheet. Memoised alongside resource(). */
  text(url: string): Promise<string | null>
  readonly stats: ResourceStats
  /** Drop the CSS blob — call when the page's stylesheets actually change. */
  invalidate(): void
  dispose(): void
}

/**
 * A page with a 40MB sprite sheet should degrade to placeholders, not build a data: URI nobody
 * can encodeURIComponent. Over-budget resources are refused and counted exactly like a CORS
 * failure, because from the frame's point of view they are the same event.
 */
const BYTE_BUDGET = 8 * 1024 * 1024

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; type: string | null } | null> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) return null
    return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') }
  } catch {
    return null // opaque / blocked by CORS — the caller degrades rather than throws
  }
}

export function createResourceCache(doc: Document = document): ResourceCache {
  let pending: Promise<string> | null = null
  // Promises, not values: two elements referencing the same URL in the same frame must share
  // one in-flight fetch, not race two.
  const resources = new Map<string, Promise<string | null>>()
  const texts = new Map<string, Promise<string | null>>()
  const stats: ResourceStats = { missingFonts: 0, blockedImages: 0, bytes: 0 }

  const cache: ResourceCache = {
    css() {
      if (!pending) pending = collectCss(doc, cache)
      return pending
    },

    resource(url) {
      let hit = resources.get(url)
      if (!hit) {
        hit = (async () => {
          if (stats.bytes >= BYTE_BUDGET) return null
          const got = await fetchBytes(url)
          if (!got) return null
          if (stats.bytes + got.bytes.length > BYTE_BUDGET) return null
          stats.bytes += got.bytes.length
          return `data:${mimeFor(url, got.type)};base64,${bytesToBase64(got.bytes)}`
        })()
        resources.set(url, hit)
      }
      return hit
    },

    text(url) {
      let hit = texts.get(url)
      if (!hit) {
        hit = (async () => {
          try {
            const res = await fetch(url, { mode: 'cors' })
            return res.ok ? await res.text() : null
          } catch {
            return null
          }
        })()
        texts.set(url, hit)
      }
      return hit
    },

    stats,

    invalidate() {
      // Only the CSS blob. Fonts and images are keyed by URL and do not change because a
      // stylesheet was added — refetching 384KB of Fraunces on every Astro page transition is
      // precisely the cost this cache exists to avoid.
      pending = null
    },

    dispose() {
      pending = null
      resources.clear()
      texts.clear()
    },
  }

  return cache
}

/**
 * cloneNode() copies ATTRIBUTES, not live DOM state. For this piece that is not a detail:
 * the whole payoff is that you interact with the real element underneath and see your own
 * interaction come back late and macroblocked. Typing into an input and seeing nothing
 * appear in the video would break exactly the effect the piece exists to produce.
 *
 * So: project live form state onto the clone as attributes, which DO survive serialization.
 */
export function syncFormState(source: Element, clone: Element): void {
  const src = source.querySelectorAll('input, textarea, select, progress, meter')
  const dst = clone.querySelectorAll('input, textarea, select, progress, meter')
  for (let i = 0; i < src.length && i < dst.length; i++) {
    const s = src[i]!
    const d = dst[i]!
    if (s instanceof HTMLInputElement && d instanceof HTMLInputElement) {
      d.setAttribute('value', s.value)
      if (s.checked) d.setAttribute('checked', '')
      else d.removeAttribute('checked')
    } else if (s instanceof HTMLTextAreaElement) {
      d.textContent = s.value
    } else if (s instanceof HTMLSelectElement && d instanceof HTMLSelectElement) {
      const opts = d.querySelectorAll('option')
      opts.forEach((o, j) => {
        if (j === s.selectedIndex) o.setAttribute('selected', '')
        else o.removeAttribute('selected')
      })
    } else if (
      (s instanceof HTMLProgressElement || s instanceof HTMLMeterElement) &&
      (d instanceof HTMLProgressElement || d instanceof HTMLMeterElement)
    ) {
      d.setAttribute('value', String(s.value))
    }
  }
}

/**
 * Scroll position is a PROPERTY, not an attribute, so cloneNode() drops it: a scrolled
 * container would capture as though it were scrolled to the top. Same class of problem as
 * form state, and it matters more here, because the component is designed to own a scroll
 * container so the canvas can stay put while the content moves under it.
 *
 * The clone renders in a separate document where scrollTop means nothing, so the scrolled
 * appearance has to be reproduced geometrically: clip the scroller and shift its children.
 *
 * WHY EACH CHILD RATHER THAN ONE WRAPPER: wrapping a scroller's children in a single
 * translated div is the obvious implementation and it is wrong. If the scroller is a flex or
 * grid container the wrapper becomes its only item and the whole layout collapses; it also
 * breaks any `>` child selector. Transforming each child individually shifts them all by the
 * same amount — which is exactly what scrolling looks like — while touching neither layout
 * nor selector matching, because transforms are paint-only.
 */
export function syncScrollState(source: Element, clone: Element): void {
  const src = [source, ...Array.from(source.querySelectorAll('*'))]
  const dst = [clone, ...Array.from(clone.querySelectorAll('*'))]

  for (let i = 0; i < src.length && i < dst.length; i++) {
    const s = src[i]!
    const top = s.scrollTop
    const left = s.scrollLeft
    if (top === 0 && left === 0) continue

    const d = dst[i]
    if (!(d instanceof HTMLElement)) continue
    d.style.overflow = 'hidden'

    const srcKids = Array.from(s.children)
    const dstKids = Array.from(d.children)
    for (let j = 0; j < srcKids.length && j < dstKids.length; j++) {
      const sk = srcKids[j]!
      const dk = dstKids[j]
      if (!(dk instanceof HTMLElement)) continue
      // A fixed child is anchored to the viewport, not to the scroller: it must NOT move.
      if (getComputedStyle(sk).position === 'fixed') continue
      // Preserve whatever transform the child already had; the scroll offset composes as the
      // OUTERMOST operation (rightmost applies first), so the element is shifted after its
      // own transform rather than instead of it.
      const existing = getComputedStyle(sk).transform
      const own = existing && existing !== 'none' ? ' ' + existing : ''
      dk.style.transform = `translate(${-left}px, ${-top}px)${own}`
    }
  }

  /*
   * position:fixed must hold still while the page scrolls under it, and it is the single
   * trickiest thing in this file, because **a transformed element becomes the containing
   * block for its fixed descendants**. Shifting the scroller's children therefore re-anchors
   * every fixed element below them, silently.
   *
   * Compensating with an equal-and-opposite translate is the obvious repair and it is WRONG.
   * It happens to work for `top`-anchored elements, which is exactly why it looks right at
   * first: measured, a top-anchored header went from 17% to 100% identical across a 400px
   * scroll. But a `bottom`-anchored element re-anchors to the bottom of the whole 300vh page
   * rather than the viewport, so it renders far outside the frame and no translate brings it
   * back — the anchor changed, not the offset.
   *
   * So: convert to absolute against whatever the clone's containing block will actually be,
   * using coordinates measured from the live DOM. Offsets measured relative to that block
   * already account for the scroll, because the block itself is shifted by the same amount.
   */
  const clonedTransform = (p: HTMLElement): boolean => {
    const par = p.parentElement
    return (
      !!par &&
      (par.scrollTop !== 0 || par.scrollLeft !== 0) &&
      getComputedStyle(p).position !== 'fixed'
    )
  }

  /** The ancestor the clone will position this element against. */
  const containingBlock = (el: HTMLElement): HTMLElement | null => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (
        p === source ||
        cs.position !== 'static' ||
        cs.transform !== 'none' ||
        cs.filter !== 'none' ||
        cs.perspective !== 'none' ||
        /transform|filter|perspective/.test(cs.willChange) ||
        clonedTransform(p) // static in the source, transformed once we shift it
      ) {
        return p
      }
    }
    return null
  }

  for (let i = 0; i < src.length && i < dst.length; i++) {
    const s = src[i]!
    if (!(s instanceof HTMLElement)) continue
    if (getComputedStyle(s).position !== 'fixed') continue
    const cb = containingBlock(s)
    if (!cb) continue

    const d = dst[i]
    if (!(d instanceof HTMLElement)) continue
    const r = s.getBoundingClientRect()
    const cbr = cb.getBoundingClientRect()
    d.style.position = 'absolute'
    d.style.left = `${r.left - cbr.left}px`
    d.style.top = `${r.top - cbr.top}px`
    // The offsets above are complete on their own; any of these left set would fight them.
    d.style.right = 'auto'
    d.style.bottom = 'auto'
    d.style.margin = '0'
  }
}


/**
 * Every capture pass, over one source/clone pair, in the only order that works.
 *
 * ORDER IS LOAD-BEARING:
 *  1. form state   — attributes only, no structural change.
 *  2. positioning  — writes inline styles onto clone elements.
 *  3. replacement  — copies the CLONE's inline style onto the substitute, so it has to see
 *                    what positioning wrote; a fixed <canvas> would otherwise lose its anchor.
 *  4. shadow DOM   — the only pass that ADDS nodes with no source counterpart, so it goes last
 *                    (and recurses into itself for the content it flattens in).
 *
 * The pairing is built once and shared: see pairs.ts for why re-querying mid-pass is a silent
 * correctness bug rather than an inefficiency.
 */
export interface PreparedClone {
  /** CSS the passes generated (flattened shadow styles), to append after the cached sheet. */
  extraCss: string
  /** What this capture could not reproduce. */
  report: CaptureReport
}

export async function prepareClone(
  source: Element,
  clone: Element,
  cache: ResourceCache,
): Promise<PreparedClone> {
  const pairs: ElementPair[] = pairElements(source, clone)
  const report = emptyReport()

  syncFormState(source, clone)
  syncScrollState(source, clone)
  await replaceUnserializable(pairs, cache, report)

  report.missingFonts = cache.stats.missingFonts
  report.blockedImages += cache.stats.blockedImages
  return { extraCss: '', report }
}
