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
 * NOT HANDLED YET — the remaining drop-anywhere work, deferred deliberately:
 *  - cross-origin <img>: taints the canvas, which kills new VideoFrame(). Needs fetch+data-URI
 *    per image, and a visible degradation path for images that refuse CORS.
 *  - <canvas> descendants: cloneNode does not copy the bitmap. Needs toDataURL per canvas.
 *  - shadow DOM: not traversed by XMLSerializer; needs manual flattening.
 *  - <iframe>: renders blank inside foreignObject. Probably unfixable; document it.
 *  - CSS background-image url(): same cross-origin problem as <img>.
 */
