/**
 * Elements whose CONTENT is not in their markup, replaced by something that is.
 *
 * XMLSerializer writes attributes. A <canvas>'s bitmap, a <video>'s current frame and an
 * <img>'s decoded pixels are none of them attributes, and an <img>'s src is an attribute that
 * points somewhere the SVG document is not allowed to go — an <img>-loaded SVG has external
 * resource loading disabled, so a perfectly valid https src renders as nothing at all.
 *
 * Worse than nothing, for cross-origin images: if the SVG COULD load them it would taint the
 * canvas we draw it into, and a tainted canvas makes `new VideoFrame(canvas)` throw
 * SecurityError, which kills the pipeline outright. Fetching the bytes ourselves and embedding
 * them as data: URIs is what keeps the whole permissionless path origin-clean.
 *
 * When a resource refuses (no Access-Control-Allow-Origin, a tainted canvas, a blank WebGL
 * buffer) the answer is a flat mid-grey block of the same box, tagged `data-rt-blocked`. Not a
 * hole: a dropout. A hole reads as a layout bug, a grey block reads as the video losing
 * something — which is at least the right genre — and mid-grey is also the value the encoder
 * spends the fewest bits on, so it stays honest under coarseness.
 *
 * THIS IS THE EXPENSIVE PASS, and it is toDataURL that costs, not the walking. Measured on the
 * hostile page (1920x885, one drawn canvas and two videos): the whole grab is ~15ms, of which
 * prepareClone is 11.8ms, of which one canvas.toDataURL() is 2.5ms and two video snapshots are
 * 3.9ms. Fetched images are cached by URL and cost nothing after the first frame; canvas and
 * video cannot be, because their whole point is that they changed. PNG is kept over a much
 * faster toDataURL('image/jpeg') because JPEG has no alpha, and a transparent canvas overlay
 * would silently acquire a black ground.
 */

import type { ElementPair } from './pairs.ts'
import type { ResourceCache } from './inlineResources.ts'
import type { CaptureReport } from './report.ts'
import { collectCssUrls, isFontUrl, rewriteCssUrls } from './cssResources.ts'

/** Mid-grey: reads as a dropout, and costs the encoder almost nothing. */
const BLOCKED_FILL = '#8a8a8a'

function placeholderFor(pair: ElementPair, box: DOMRect): HTMLElement {
  const { src, dst } = pair
  const el = dst.ownerDocument.createElement('div')
  el.setAttribute('data-rt-blocked', '')
  /*
   * The SOURCE's display, not a fixed one. This used to be inline-block always — right for an
   * <img> inside a line of text, wrong for the usual `img { display: block }`: an inline-block
   * sits on the baseline and gains the strut's descent below it, so every figure holding a
   * blocked image grew by a few px and pushed everything under it down. Measured on /hostile/:
   * the whole grid below row one captured 6px low. An inline source still becomes
   * inline-block, since a <div> that is `inline` would ignore its width and height.
   *
   * The clone's inline style goes first so positioning's anchoring survives the swap, exactly
   * as imageFrom() keeps it; the box and fill after it win.
   */
  const cs = getComputedStyle(src)
  const display = cs.display === 'inline' ? 'inline-block' : cs.display
  const prior = dst.getAttribute('style')
  el.setAttribute(
    'style',
    `${prior ? prior.replace(/;?\s*$/, ';') : ''}display:${display};vertical-align:${cs.verticalAlign};` +
      `box-sizing:border-box;width:${box.width}px;height:${box.height}px;background:${BLOCKED_FILL}`,
  )
  return el
}

/**
 * An <img> carrying the clone's attributes and inline style, sized to the source's MEASURED box.
 *
 * width/height are deliberately not copied from a <canvas>: those attributes are its backing
 * store resolution, not its CSS box, and the two differ on every retina canvas ever written.
 * The inline style survives because positioning has already written into it — a fixed canvas
 * that lost its anchoring here would drift with the scroll.
 */
function imageFrom(doc: Document, clone: Element, dataUri: string, box: DOMRect): HTMLImageElement {
  const img = doc.createElement('img')
  for (const attr of Array.from(clone.attributes)) {
    if (attr.name === 'width' || attr.name === 'height' || attr.name === 'src') continue
    img.setAttribute(attr.name, attr.value)
  }
  img.setAttribute('src', dataUri)
  img.style.width = `${box.width}px`
  img.style.height = `${box.height}px`
  return img
}

/**
 * A FRESH scratch canvas per conversion, never a shared one.
 *
 * A canvas that is tainted once is tainted for the rest of its life — the flag is on the
 * canvas, not on the draw. Share one scratch across the page and the first cross-origin video
 * poisons every same-origin canvas drawn after it into a placeholder, which looks exactly like
 * a CORS problem on elements that do not have one.
 */
function snapshot(doc: Document, draw: (ctx: CanvasRenderingContext2D) => void, w: number, h: number): string | null {
  const c = doc.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return null
  try {
    draw(ctx)
    return c.toDataURL()
  } catch {
    return null // tainted, or a zero-size source
  }
}

async function handleImg(pair: ElementPair, cache: ResourceCache, report: CaptureReport): Promise<void> {
  const src = pair.src as HTMLImageElement
  const dst = pair.dst as HTMLImageElement

  /*
   * srcset/sizes cannot come along: the SVG document has a different viewport and would
   * re-pick a candidate we have not inlined. currentSrc is what THIS layout actually resolved
   * to, which is the one whose bytes we want; src alone is empty on a srcset-only <img>.
   */
  const url = src.currentSrc || src.src
  dst.removeAttribute('srcset')
  dst.removeAttribute('sizes')
  dst.removeAttribute('loading')
  dst.removeAttribute('fetchpriority')
  // <picture> re-runs source selection on its children, so the <source>s have to go too.
  if (dst.parentElement?.tagName === 'PICTURE') {
    for (const s of Array.from(dst.parentElement.querySelectorAll('source'))) s.remove()
  }

  if (!url || url.startsWith('data:')) return
  const data = await cache.resource(url)
  if (data !== null) {
    dst.setAttribute('src', data)
    return
  }
  report.blockedImages++
  dst.replaceWith(placeholderFor(pair, src.getBoundingClientRect()))
}

async function handleSvgImage(pair: ElementPair, cache: ResourceCache, report: CaptureReport): Promise<void> {
  const src = pair.src as SVGImageElement
  const dst = pair.dst
  const url = src.href?.baseVal || src.getAttribute('href') || src.getAttribute('xlink:href')
  if (!url || url.startsWith('data:')) return
  const abs = new URL(url, src.ownerDocument.baseURI).href
  const data = await cache.resource(abs)
  if (data === null) {
    // No sane placeholder inside an <svg> subtree — a <div> there renders nothing. Counted and
    // left alone: the image is simply absent, which is the honest outcome.
    report.blockedImages++
    return
  }
  dst.setAttribute('href', data)
  if (dst.hasAttribute('xlink:href')) dst.setAttribute('xlink:href', data)
}

function handleCanvas(pair: ElementPair, report: CaptureReport): void {
  const src = pair.src as HTMLCanvasElement
  const dst = pair.dst
  const doc = dst.ownerDocument
  const box = src.getBoundingClientRect()

  /*
   * toDataURL() on the LIVE canvas, not a copy: we want its bitmap, and copying it through a
   * scratch canvas would only add a taint surface. A WebGL context without
   * preserveDrawingBuffer returns a blank image here — the browser has already discarded the
   * buffer by the time we ask. That is a platform rule, not something to work around; it is
   * documented in the README rather than fought.
   */
  let data: string | null = null
  try {
    data = src.toDataURL()
  } catch {
    data = null // tainted by a cross-origin drawImage somewhere in its history
  }

  if (data === null) {
    report.blockedImages++
    dst.replaceWith(placeholderFor(pair, box))
    return
  }
  dst.replaceWith(imageFrom(doc, dst, data, box))
}

function handleVideo(pair: ElementPair, report: CaptureReport): void {
  const src = pair.src as HTMLVideoElement
  const dst = pair.dst
  const doc = dst.ownerDocument
  const box = src.getBoundingClientRect()
  const w = src.videoWidth
  const h = src.videoHeight

  const data =
    w > 0 && h > 0 ? snapshot(doc, (ctx) => ctx.drawImage(src, 0, 0, w, h), w, h) : null

  if (data === null) {
    // Not loaded yet, or cross-origin without CORS — drawImage succeeds and toDataURL throws.
    report.blockedImages++
    dst.replaceWith(placeholderFor(pair, box))
    return
  }
  dst.replaceWith(imageFrom(doc, dst, data, box))
}

/**
 * url() inside a style ATTRIBUTE.
 *
 * Found by specimen, not by reasoning: cssResources.ts covers every stylesheet, and an inline
 * style is not a stylesheet. It is in no document.styleSheets entry, has no cssRules and no
 * href — so `<div style="background-image:url(https://...)">` sailed straight past all of it
 * and rendered as a flat empty box. Which is exactly the failure mode this whole directory is
 * about: no error, no warning, just a missing image.
 *
 * Common enough to matter (every framework that computes a background from data emits one),
 * and cheap: the attribute is skipped outright unless it contains "url(".
 */
async function inlineStyleAttribute(
  dst: Element,
  baseHref: string,
  cache: ResourceCache,
  report: CaptureReport,
): Promise<void> {
  const style = dst.getAttribute('style')
  if (!style || !style.includes('url(')) return

  const inlined = new Map<string, string>()
  await Promise.all(
    collectCssUrls(style, baseHref).map(async (url) => {
      const data = await cache.resource(url)
      if (data !== null) inlined.set(url, data)
      else if (!isFontUrl(url)) report.blockedImages++
    }),
  )
  if (inlined.size === 0) return
  dst.setAttribute('style', rewriteCssUrls(style, baseHref, (abs) => inlined.get(abs) ?? null))
}

/**
 * Replace everything whose pixels are not in its markup.
 *
 * Runs AFTER positioning (it copies the inline style positioning wrote) and BEFORE shadow
 * flattening (which adds nodes with no source counterpart). See prepareClone.
 */
export async function replaceUnserializable(
  pairs: readonly ElementPair[],
  cache: ResourceCache,
  report: CaptureReport,
): Promise<void> {
  const jobs: Promise<void>[] = []
  for (const pair of pairs) {
    const { src, dst } = pair
    // Inline styles resolve against the DOCUMENT, unlike a stylesheet's own rules.
    jobs.push(inlineStyleAttribute(dst, src.ownerDocument.baseURI, cache, report))
    if (src instanceof HTMLImageElement) {
      jobs.push(handleImg(pair, cache, report))
    } else if (src instanceof SVGImageElement) {
      jobs.push(handleSvgImage(pair, cache, report))
    } else if (src instanceof HTMLCanvasElement) {
      handleCanvas(pair, report)
    } else if (src instanceof HTMLVideoElement) {
      handleVideo(pair, report)
    } else if (src instanceof HTMLIFrameElement) {
      // An iframe inside foreignObject renders blank no matter what; a cross-origin one we
      // could not read even in principle. Out of scope by decision, placeholdered and counted.
      report.iframes++
      dst.replaceWith(placeholderFor(pair, src.getBoundingClientRect()))
    }
  }
  await Promise.all(jobs)
}
