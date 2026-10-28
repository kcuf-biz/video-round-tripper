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
 *
 * Videos mostly skip all of this now: one that can be drawn as a plain box is composited onto
 * the frame after the SVG instead (see VideoOverlay below), and only the rest are snapshotted.
 */

import type { ElementPair } from './pairs.ts'
import type { ResourceCache } from './inlineResources.ts'
import type { CaptureReport } from './report.ts'
import { collectCssUrls, isFontUrl, rewriteCssUrls } from './cssResources.ts'

/** Mid-grey: reads as a dropout, and costs the encoder almost nothing. */
const BLOCKED_FILL = '#8a8a8a'

function placeholderFor(pair: ElementPair, box: DOMRect, fill = BLOCKED_FILL): HTMLElement {
  const { src, dst } = pair
  const el = dst.ownerDocument.createElement('div')
  if (fill === BLOCKED_FILL) el.setAttribute('data-rt-blocked', '')
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
      `box-sizing:border-box;width:${box.width}px;height:${box.height}px;background:${fill}`,
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

/**
 * A video drawn straight onto the captured frame, after the SVG, instead of embedded in it.
 * `dest` is the content box the frame is drawn into and `clip` what of it is visible, both in
 * viewport coordinates; foreignObjectSource maps them into the frame.
 */
export interface VideoOverlay {
  video: HTMLVideoElement
  dest: { x: number; y: number; w: number; h: number }
  clip: { x: number; y: number; w: number; h: number }
}

/*
 * WHY COMPOSITE (2026-10-11). Embedded, a video's frame is a new PNG data: URI on every grab,
 * and on iOS Safari the clip was missing from most captured frames: the SVG's own load resolved
 * before the nested <img> had painted, intermittently, in a page-sized SVG (it came through in a
 * 64px one). Decoding the same URI first did not help. Drawing the <video> onto the scratch
 * canvas after the SVG sidesteps the nested image entirely, and skips the toDataURL that was
 * the most expensive thing in the capture (2.6ms at 540px, 6.5ms at 1080px on an M4).
 *
 * The trade is z-order and effects: the overlay goes on TOP of everything, and it can only be
 * drawn as an axis-aligned box. So it is used only for a video that nothing in its ancestry
 * transforms, fades, filters, masks or blends, with square corners and a plain object-fit, and
 * whose pixels are readable. Anything else takes the embedded path as before. Content painted
 * over such a video (a caption, a play button) is drawn under it: an accepted loss, rare on the
 * pages this is for, and the reason this is not done for <canvas> as well. So a video that
 * anything may be painted over is embedded for that frame instead: a fixed or sticky element
 * overlapping it (a nav it scrolls under; see floatingRects), or any element LATER in the
 * document whose box overlaps it (a title set over a hero video, 2026-10-18; see laterOverlaps).
 * Embedded, the clip keeps the page's stacking; on WebKit it is held under the decode budget.
 */
function compositable(video: HTMLVideoElement): boolean {
  const vs = getComputedStyle(video)
  if (vs.visibility !== 'visible') return false
  if (!['fill', 'contain', 'cover'].includes(vs.objectFit)) return false
  if (vs.objectPosition !== '50% 50%') return false
  for (const corner of [vs.borderTopLeftRadius, vs.borderTopRightRadius, vs.borderBottomLeftRadius, vs.borderBottomRightRadius]) {
    if (parseFloat(corner) !== 0) return false
  }
  for (let el: Element | null = video; el; el = el.parentElement) {
    const cs = getComputedStyle(el)
    if (cs.transform !== 'none' || cs.opacity !== '1' || cs.filter !== 'none') return false
    if (cs.clipPath !== 'none' || cs.mixBlendMode !== 'normal') return false
    const mask = cs.getPropertyValue('mask-image') || cs.getPropertyValue('-webkit-mask-image')
    if (mask && mask !== 'none') return false
  }
  // Cross-origin without CORS: drawing it would taint the scratch canvas, and a tainted canvas
  // makes new VideoFrame() throw. One pixel is enough to find out.
  try {
    const probe = video.ownerDocument.createElement('canvas')
    probe.width = probe.height = 1
    const ctx = probe.getContext('2d')
    if (!ctx) return false
    ctx.drawImage(video, 0, 0, 1, 1)
    ctx.getImageData(0, 0, 1, 1)
  } catch {
    return false
  }
  return true
}

/** The video's content box and its visible part, in viewport coordinates. */
function overlayFor(video: HTMLVideoElement): VideoOverlay {
  const r = video.getBoundingClientRect()
  const cs = getComputedStyle(video)
  const px = (v: string) => parseFloat(v) || 0
  const box = {
    x: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
    y: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
    w: r.width - px(cs.borderLeftWidth) - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderRightWidth),
    h: r.height - px(cs.borderTopWidth) - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderBottomWidth),
  }
  // object-fit: where the frame lands inside the box. Centred, the only position allowed.
  const vw = video.videoWidth
  const vh = video.videoHeight
  let dest = box
  if (cs.objectFit !== 'fill') {
    const scale = (cs.objectFit === 'contain' ? Math.min : Math.max)(box.w / vw, box.h / vh)
    const w = vw * scale
    const h = vh * scale
    dest = { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
  }
  // Visible part: the content box, cut by every scrolling or clipping ancestor's padding box.
  let x0 = box.x
  let y0 = box.y
  let x1 = box.x + box.w
  let y1 = box.y + box.h
  for (let el = video.parentElement; el; el = el.parentElement) {
    const o = getComputedStyle(el)
    if (o.overflowX === 'visible' && o.overflowY === 'visible') continue
    const p = el.getBoundingClientRect()
    const left = p.left + el.clientLeft
    const top = p.top + el.clientTop
    x0 = Math.max(x0, left)
    y0 = Math.max(y0, top)
    x1 = Math.min(x1, left + el.clientWidth)
    y1 = Math.min(y1, top + el.clientHeight)
  }
  return { video, dest, clip: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) } }
}

/**
 * Fixed and sticky elements, which commonly sit over a scrolling video (a nav), as the boxes they
 * actually paint (see paintedRects). A composited video would be drawn over them, so a video one
 * of them overlaps is embedded instead for that frame. Only asked for when the subtree holds a
 * video: it is a computed-style sweep.
 */
function floatingRects(pairs: readonly ElementPair[]): { el: Element; rect: DOMRect }[] {
  const out: { el: Element; rect: DOMRect }[] = []
  for (const { src } of pairs) {
    const pos = getComputedStyle(src).position
    if (pos === 'fixed' || pos === 'sticky') {
      for (const rect of paintedRects(src)) out.push({ el: src, rect })
    }
  }
  return out
}

/**
 * Where an element actually paints, as boxes. A transparent wrapper (no background, border,
 * shadow or outline, and no text of its own) paints only through its children, so it stands for
 * their boxes instead of its own. The common case is a full-width fixed nav whose mark and
 * buttons sit at the edges: its own box covers a centred hero video at the top of the page, but
 * nothing it draws does, and treating the whole box as cover sent that video down the slower
 * embedded path on every frame (2026-10-18, a real page, 16fps against 21).
 */
function paintedRects(el: Element): DOMRect[] {
  const cs = getComputedStyle(el)
  const paintsBox =
    cs.backgroundImage !== 'none' ||
    !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor) ||
    parseFloat(cs.borderTopWidth) + parseFloat(cs.borderRightWidth) + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth) > 0 ||
    cs.boxShadow !== 'none' ||
    (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
    Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== '') ||
    el.children.length === 0
  if (paintsBox) return [el.getBoundingClientRect()]
  return Array.from(el.children).flatMap(paintedRects)
}

/**
 * Whether an element after the video in document order (so painted over it, short of z-index
 * games) overlaps its box. Ancestors come before it and its own children (<source>) are inside
 * it, so neither counts. Costs one getBoundingClientRect per later element, and only runs for a
 * video that could otherwise be composited.
 */
function laterOverlaps(pairs: readonly ElementPair[], index: number, video: HTMLVideoElement): boolean {
  const v = video.getBoundingClientRect()
  for (let j = index + 1; j < pairs.length; j++) {
    const el = pairs[j].src
    if (video.contains(el) || el.contains(video)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.left < v.right && v.left < r.right && r.top < v.bottom && v.top < r.bottom) {
      return true
    }
  }
  return false
}

function overlapsFloating(video: HTMLVideoElement, floating: { el: Element; rect: DOMRect }[]): boolean {
  const v = video.getBoundingClientRect()
  return floating.some(
    ({ el, rect: r }) =>
      !el.contains(video) && r.left < v.right && v.left < r.right && r.top < v.bottom && v.top < r.bottom,
  )
}

/**
 * Pixels the embedded snapshot of a video gets: never more than its box (the SVG renders at CSS
 * px, so the rest is thrown away), and under iOS Safari's background-decode threshold where that
 * applies.
 *
 * WHY THE BUDGET (2026-10-12). iOS Safari draws a large image nested in an SVG-as-image blank
 * until a background decode finishes, and a video frame is a new image on every grab, so above
 * the threshold the embedded clip was missing from most frames. Measured on the author's iPhone, one
 * fresh frame in a tiny SVG: kept 100% at 64, 128 and 256px square, 0-25% at 384 and 540px. So
 * 256x256 is the largest size known to be safe, and it is applied as an AREA, keeping the aspect.
 * Compositing (VideoOverlay) avoids the question for a plain box; this is what keeps the EMBEDDED
 * fallback (a video under a fixed nav, or transformed) from flickering there. Chrome keeps every
 * size, so it gets only the box cap and stays sharp.
 */
export const WEBKIT_EMBED_BUDGET = 256 * 256

export function embedSize(
  w: number,
  h: number,
  boxW: number,
  boxH: number,
  budget = Infinity,
): { width: number; height: number } {
  let s = 1
  if (boxW > 0 && boxH > 0) s = Math.min(s, Math.max(boxW / w, boxH / h))
  if (w * h * s * s > budget) s = Math.sqrt(budget / (w * h))
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

/*
 * Every browser on iOS is WebKit, and so is Safari on macOS; Chrome, Edge and the rest on other
 * platforms say "Chrome" or "Android" in the UA. No feature test exists for decode timing.
 */
const isWebKit =
  typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Android/.test(navigator.userAgent)

function handleVideo(
  pair: ElementPair,
  report: CaptureReport,
  overlays: VideoOverlay[] | null,
  covered: () => boolean,
): void {
  const src = pair.src as HTMLVideoElement
  const dst = pair.dst
  const doc = dst.ownerDocument
  const box = src.getBoundingClientRect()
  const w = src.videoWidth
  const h = src.videoHeight

  if (overlays && w > 0 && h > 0 && compositable(src) && !covered()) {
    // An empty box holds its place in the layout; the frame is drawn over it afterwards.
    overlays.push(overlayFor(src))
    dst.replaceWith(placeholderFor(pair, box, 'transparent'))
    return
  }

  const size = embedSize(w, h, box.width, box.height, isWebKit ? WEBKIT_EMBED_BUDGET : Infinity)
  const data =
    w > 0 && h > 0
      ? snapshot(doc, (ctx) => ctx.drawImage(src, 0, 0, size.width, size.height), size.width, size.height)
      : null

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
  /** Where composited videos go; null embeds every video, the pre-2026-10-11 behaviour. */
  overlays: VideoOverlay[] | null = [],
): Promise<void> {
  const jobs: Promise<void>[] = []
  let floating: { el: Element; rect: DOMRect }[] | undefined
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
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
      const video = src
      handleVideo(pair, report, overlays, () => {
        floating ??= floatingRects(pairs)
        return overlapsFloating(video, floating) || laterOverlaps(pairs, i, video)
      })
    } else if (src instanceof HTMLIFrameElement) {
      // An iframe inside foreignObject renders blank no matter what; a cross-origin one we
      // could not read even in principle. Out of scope by decision, placeholdered and counted.
      report.iframes++
      dst.replaceWith(placeholderFor(pair, src.getBoundingClientRect()))
    }
  }
  await Promise.all(jobs)
}
