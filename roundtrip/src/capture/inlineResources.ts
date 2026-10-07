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
 *   animations.ts           CSS motion, snapshotted to inline values (the SVG's clock is t=0)
 *   replaceUnserializable.ts <img>/<canvas>/<video>/<iframe> — pixels that are not markup
 *   pairs.ts                the index-matched source/clone pairing they all work against
 */

import {
  addShadowAnimations,
  freezeAnimations,
  indexAnimationsByTarget,
  snapshotInheritedCustomProperties,
} from './animations.ts'
import { countBrokenReferences, snapshotAncestorContext, type AncestorContext } from './context.ts'
import { collectCss, bytesToBase64, mimeFor } from './cssResources.ts'
import { rewriteStateRules, STATE_BASE_CSS, syncInteractionState } from './interactionState.ts'
import { pairDescendants, pairElements, type ElementPair } from './pairs.ts'
import { replaceUnserializable } from './replaceUnserializable.ts'
import { emptyReport, type CaptureReport } from './report.ts'
import { syncScrollState } from './positioning.ts'
import { flattenShadowRoots } from './shadowDom.ts'

export { syncScrollState } from './positioning.ts'

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
  /** Document rules that lost declarations with no authored text to recover them (#87). Per CSS build. */
  lostDeclarations: number
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
 *
 * SIZE IS A PER-FRAME COST, not a one-off: every inlined byte is re-encoded into the SVG data
 * URI on every single grab. Measured on this M4 in Chrome, encodeURIComponent runs at
 * 8.4ms/MB (linear: 0.16MB -> 0.6ms, 0.64MB -> 5.1ms, 2.56MB -> 21.4ms, +9% output size).
 * So this ceiling is worth ~64ms/frame of encoding on its own. It is a safety valve against a
 * pathological page, NOT a performance target -- a page anywhere near it will not be realtime.
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

/** Nodes whose arrival or departure changes what the page's CSS is. */
function isStyleNode(n: Node): boolean {
  if (!(n instanceof Element)) return false
  return n.localName === 'style' || (n.localName === 'link' && (n as HTMLLinkElement).rel === 'stylesheet')
}

export function createResourceCache(doc: Document = document): ResourceCache {
  let pending: Promise<string> | null = null
  // Promises, not values: two elements referencing the same URL in the same frame must share
  // one in-flight fetch, not race two.
  const resources = new Map<string, Promise<string | null>>()
  const texts = new Map<string, Promise<string | null>>()
  const stats: ResourceStats = { missingFonts: 0, blockedImages: 0, bytes: 0, lostDeclarations: 0 }

  const cache: ResourceCache = {
    css() {
      // State selectors are rewritten ONCE, here, with the blob: the rewrite is text-only and
      // the per-frame half is just stamping attributes. See interactionState.ts.
      if (!pending) {
        stats.lostDeclarations = 0
        pending = collectCss(doc, cache).then((css) => STATE_BASE_CSS + rewriteStateRules(css))
      }
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
      watcher?.disconnect()
    },
  }

  /*
   * The CSS blob is built once and reused for the life of the cache, which is the only reason
   * capture is affordable at all (229ms cold, ~5ms/frame warm). The cost of that is a cache
   * that goes stale the moment the page adds a stylesheet — an Astro view transition, a lazily
   * imported component, a Vite HMR update — and a stale blob does not error. It renders the
   * previous page's styling, silently, forever.
   *
   * Watching <head> is the cheap fix: style nodes essentially always land there, the callback
   * only fires on real mutations, and invalidation is just dropping a promise. Font and image
   * bytes are keyed by URL and deliberately survive it.
   */
  const watcher =
    typeof MutationObserver === 'undefined' || !doc.head
      ? null
      : new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === 'attributes') {
              if (isStyleNode(r.target)) return cache.invalidate()
              continue
            }
            for (const n of Array.from(r.addedNodes)) if (isStyleNode(n)) return cache.invalidate()
            for (const n of Array.from(r.removedNodes)) if (isStyleNode(n)) return cache.invalidate()
          }
        })
  watcher?.observe(doc.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'rel', 'media', 'disabled'],
  })

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
export function syncFormState(pairs: readonly ElementPair[]): void {
  for (const { src: s, dst: d } of pairs) {
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
 * Every capture pass, over one source/clone pair, in the only order that works.
 *
 * ORDER IS LOAD-BEARING:
 *  1. form state   — attributes only, no structural change. Interaction state (:hover,
 *                    :focus...) rides along: also attributes only.
 *  2. animations   — pins animated properties as inline values. BEFORE positioning, because
 *                    positioning writes a COMPOSED `translate(scroll) <computed transform>`
 *                    and this pass writes the bare animated transform: freezing second would
 *                    overwrite the composed value and silently drop the scroll offset.
 *  3. positioning  — writes inline styles onto clone elements.
 *  4. replacement  — copies the CLONE's inline style onto the substitute, so it has to see
 *                    what positioning wrote; a fixed <canvas> would otherwise lose its anchor.
 *  5. shadow DOM   — the only pass that ADDS nodes with no source counterpart, so it goes last
 *                    (and recurses into itself for the content it flattens in).
 *
 * The pairing is built once and shared: see pairs.ts for why re-querying mid-pass is a silent
 * correctness bug rather than an inefficiency.
 */
export interface PreparedClone {
  /** CSS the passes generated (flattened shadow styles), to append after the cached sheet. */
  extraCss: string
  /** What the clone inherited from above itself: see context.ts. */
  context: AncestorContext
  /** What this capture could not reproduce. */
  report: CaptureReport
}

export async function prepareClone(
  source: Element,
  clone: Element,
  cache: ResourceCache,
): Promise<PreparedClone> {
  const report = emptyReport()

  /*
   * ONE document-level getAnimations() for the whole capture, shadow subtrees included, rather
   * than one per element or one per recursion. See animations.ts: the per-element call walks
   * the document's animation list every time it is asked.
   */
  const animations = indexAnimationsByTarget(source.ownerDocument)

  /** The four index-matched passes, plus shadow flattening, over one paired subtree. */
  const runPasses = async (pairs: ElementPair[]): Promise<string> => {
    syncFormState(pairs)
    syncInteractionState(pairs)
    // The document index cannot see into shadow trees; fold in each open root found at this
    // level so that when flattening recurses into it, its pairs find their animations (#74).
    for (const { src } of pairs) if (src.shadowRoot) addShadowAnimations(animations, src.shadowRoot)
    freezeAnimations(pairs, animations)
    syncScrollState(source, pairs)
    await replaceUnserializable(pairs, cache, report)
    // Last, and recursive: it is the only pass that adds nodes with no source counterpart.
    return flattenShadowRoots(pairs, cache, report, runPasses, pairDescendants)
  }

  /*
   * Root-only, and outside runPasses: the clone root is the only element that can carry the
   * subtree's inherited custom properties, and a flattened shadow fragment has no root of its
   * own to put them on — it inherits from this one, which is the correct answer anyway.
   */
  snapshotInheritedCustomProperties(source, clone)

  const context = await snapshotAncestorContext(source, cache, report)

  const pairs = pairElements(source, clone)
  const extraCss = await runPasses(pairs)

  // After the passes, against the clone as it will be serialized.
  report.brokenReferences = countBrokenReferences(pairs, clone)

  report.missingFonts = cache.stats.missingFonts
  report.blockedImages += cache.stats.blockedImages
  report.lostDeclarations += cache.stats.lostDeclarations
  return { extraCss, context, report }
}
