/**
 * THE DROP-ANYWHERE SEAM.
 *
 * Everything that separates "works on the page we authored" from "works on any page" lives
 * here. Right now it handles the two things the spike proved are load-bearing; the rest is
 * listed at the bottom as the explicit remaining work. Keeping this as a real module with a
 * real signature from day one means reaching drop-anywhere later is filling in one file
 * rather than restructuring the capture path.
 *
 * Why this matters more than it looks: an <img>-loaded SVG is a SEPARATE DOCUMENT. It cannot
 * see the host page's stylesheets or fonts. Anything not inlined here simply is not there.
 * The spike measured the consequence — without font inlining the demo heading silently
 * rendered in Georgia instead of Fraunces and 32.9% of its pixels differed. It does not error.
 * It just quietly renders the wrong thing, which reads as a broken website rather than as a
 * codec artifact, i.e. it destroys the entire point of the piece.
 */

/** Read every same-origin stylesheet. Cross-origin sheets throw on .cssRules and are skipped here. */
export function collectSameOriginCss(doc: Document = document): string {
  let css = ''
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\n'
    } catch {
      // Cross-origin: unreadable via CSSOM. buildExternalCss() fetches these instead.
    }
  }
  return css
}

const FONT_URL = /url\((https?:\/\/[^)]+?\.(?:woff2|woff|ttf|otf))\)/g

async function toDataUri(url: string, mime: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!)
    return `data:${mime};base64,${btoa(bin)}`
  } catch {
    return null // opaque / blocked by CORS — caller degrades rather than throws
  }
}

/**
 * Fetch cross-origin stylesheets that CSSOM refuses to expose, and inline every font file
 * they reference as a data URI.
 *
 * Expensive — the spike measured 229ms and 384KB for six Fraunces faces — so this is
 * cached by createResourceCache() and reused across frames. Rebuilding it per frame is what
 * made modern-screenshot look like it was hanging: uncached, it refetched the same 384KB on
 * every single call.
 */
export async function buildExternalCss(doc: Document = document): Promise<string> {
  const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]'))
  const readable = new Set<string>()
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      void sheet.cssRules // same-origin, already covered by collectSameOriginCss
      if (sheet.href) readable.add(sheet.href)
    } catch {
      /* cross-origin */
    }
  }

  let css = ''
  for (const link of links) {
    if (!link.href || readable.has(link.href)) continue
    let text: string
    try {
      const res = await fetch(link.href, { mode: 'cors' })
      if (!res.ok) continue
      text = await res.text()
    } catch {
      continue
    }
    const urls = Array.from(new Set(Array.from(text.matchAll(FONT_URL), (m) => m[1]!)))
    const pairs = await Promise.all(urls.map(async (u) => [u, await toDataUri(u, 'font/woff2')] as const))
    for (const [url, data] of pairs) if (data) text = text.replaceAll(url, data)
    css += text + '\n'
  }
  return css
}

export interface ResourceCache {
  /** The full stylesheet to embed in the SVG. Built once, reused every frame. */
  css(): Promise<string>
  /** Drop the cache — call when the page's stylesheets or fonts actually change. */
  invalidate(): void
  dispose(): void
}

export function createResourceCache(doc: Document = document): ResourceCache {
  let pending: Promise<string> | null = null
  return {
    css() {
      if (!pending) {
        pending = (async () => (await buildExternalCss(doc)) + collectSameOriginCss(doc))()
      }
      return pending
    },
    invalidate() {
      pending = null
    },
    dispose() {
      pending = null
    },
  }
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
 * NOT HANDLED YET — the remaining drop-anywhere work, deferred deliberately:
 *  - cross-origin <img>: taints the canvas, which kills new VideoFrame(). Needs fetch+data-URI
 *    per image, and a visible degradation path for images that refuse CORS.
 *  - <canvas> descendants: cloneNode does not copy the bitmap. Needs toDataURL per canvas.
 *  - shadow DOM: not traversed by XMLSerializer; needs manual flattening.
 *  - <iframe>: renders blank inside foreignObject. Probably unfixable; document it.
 *  - CSS background-image url(): same cross-origin problem as <img>.
 *  - position:sticky inside a scroller: shifted with everything else, so it will not
 *    stick in the capture. Needs per-element handling if it ever matters.
 */
