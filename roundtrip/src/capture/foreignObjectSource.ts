import type { CaptureReport, CaptureSource } from '../types.ts'
import { createResourceCache, prepareClone, type ResourceCache } from './inlineResources.ts'
import { escapeCdata, explainUndecodable, makeWellFormed } from './wellFormed.ts'

/**
 * The default capture path: serialize the live element into an SVG <foreignObject>, load it
 * as an image, and draw it to a canvas.
 *
 * Measured on the spike page (860x540, six webfont faces, Chrome 150 / macOS):
 *   8ms median, 18ms p95  -> ~125fps, untainted, full font fidelity.
 * That is ~3x faster than the best library tried (snapdom, 22ms) with no dependency.
 *
 * Re-measured after the hardening passes landed, same machine:
 *   demo page,    1920x885, no media:            4.2ms median, 12.4ms p95
 *   hostile page, 1920x885, canvas + 2 video:   12.6ms median, 17.4ms p95
 * Phase breakdown on the hostile page: clone 0.2ms, prepareClone 11.8ms, serialize 0.7ms,
 * encodeURIComponent 1.3ms, img.decode 1.1ms. Both pages stay realtime at 30fps.
 *
 * TWO NON-OBVIOUS REQUIREMENTS, both verified rather than assumed:
 *
 * 1. DATA URI, NEVER BLOB URL. All browsers treat SVG-as-image containing <foreignObject> as
 *    origin-clean when the source is a data: URI. Blob URLs still taint in Chromium and WebKit.
 *    A tainted canvas throws SecurityError from new VideoFrame(), which kills the pipeline
 *    outright. This is the single line that makes the permissionless path viable at all.
 *
 * 2. THE STYLESHEET MUST BE CACHED. Rebuilding the inlined @font-face block per frame costs
 *    229ms and 384KB. Cached it costs ~5ms/frame. See inlineResources.ts.
 */
export interface ForeignObjectOptions {
  /** Encode dimensions. Defaults to the element's layout size. */
  width?: number
  height?: number
  /**
   * The rect inside the encode frame the content is scaled into, from the top-left. Defaults
   * to the whole frame. Smaller than the frame when the encoder's even dimensions overshoot an
   * odd display size, or under encodeScale — see contentSize() in frameBudget.ts.
   */
  contentWidth?: number
  contentHeight?: number
  cache?: ResourceCache
  /** Called when a frame fails to rasterize, rather than throwing into the render loop. */
  onError?: (err: Error) => void
}

const borderX = (el: HTMLElement) => {
  const cs = getComputedStyle(el)
  return (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0)
}

/** Escape for a double-quoted XML attribute. Computed font-family values carry quotes. */
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export function createForeignObjectSource(
  element: HTMLElement,
  opts: ForeignObjectOptions = {},
): CaptureSource {
  const cache = opts.cache ?? createResourceCache(element.ownerDocument)
  const ownsCache = !opts.cache
  // One scratch canvas for the lifetime of the source. Allocating per frame churns badly
  // at 100+fps and shows up as GC sawtooth rather than as a steady cost.
  const scratch = document.createElement('canvas')
  const ctx = scratch.getContext('2d', { alpha: false, willReadFrequently: false })
  let disposed = false
  /*
   * What the LAST grab could not reproduce, not a running total: "what is this page degrading
   * on right now" is the question the report answers.
   *
   * Undefined until the first grab finishes, and deliberately NOT an empty report. Seeding it
   * with zeroes was measured lying on the hostile page: the controller resolves its codec
   * asynchronously and paints nothing until then, so the panel sat reading "0 blocked images"
   * over a page with a known blocked image. Zeroes have to mean "captured, lost nothing".
   */
  let last: CaptureReport | undefined

  async function grab(timestamp: number): Promise<VideoFrame> {
    if (disposed) throw new Error('capture source disposed')
    const w = opts.width ?? element.offsetWidth
    const h = opts.height ?? element.offsetHeight
    const cw = Math.min(w, opts.contentWidth ?? w)
    const ch = Math.min(h, opts.contentHeight ?? h)
    if (w === 0 || h === 0) throw new Error('capture target has zero size')

    const css = await cache.css()
    const clone = element.cloneNode(true) as HTMLElement
    /*
     * PIN THE CLONE'S BOX. The clone renders as the root of a document with none of its
     * ancestors in it, so every percentage in its own sizing resolves against nothing: an
     * element laid out by `height: 100%` inside a bounded parent — which is exactly what
     * .rt-content is — collapses to its content height in the clone. Measured on example.com
     * through the IIFE: the SVG viewport was 1152x885 and the clone filled the top 128px of
     * it, so 85% of every frame was empty. The measured box is the ground truth here; the
     * cascade cannot be.
     *
     * The LIVE layout box, not the encode size: those differ under encodeScale, and the
     * clone's job is to look like the element does, not like the encoder's frame.
     */
    clone.style.boxSizing = 'border-box'
    const liveW = element.offsetWidth || cw
    const liveH = element.offsetHeight || ch
    clone.style.width = `${liveW}px`
    clone.style.height = `${liveH}px`
    /*
     * An OVERLAY scrollbar (macOS, iOS, most phones) is invisible at rest in the live page but
     * the clone is a fresh scroller that paints its thumb every frame: a grey sliver pinned to
     * the frame's right edge that nobody sees on the page itself. Measured on the marketing page,
     * where it read as a light or a dark bar depending on what the scroller's own background
     * happened to be. Only when the live scrollbar takes no space: a classic scrollbar is really
     * there, and hiding it in the clone would also hand its width back to the layout.
     */
    if (element.offsetWidth === element.clientWidth + borderX(element)) clone.style.scrollbarWidth = 'none'
    const prepared = await prepareClone(element, clone, cache)
    last = prepared.report
    // After every pass, so what shadow flattening moved in is covered too. See wellFormed.ts:
    // one stray `<!-- -- -->` or Alpine `@click` otherwise loses the WHOLE frame, not a node.
    makeWellFormed(clone)

    const xml = new XMLSerializer().serializeToString(clone)
    const svg =
      /*
       * Sized to the CONTENT RECT and viewBoxed to the element's live box, so the page is scaled
       * into it. There was no viewBox before, which made encodeScale a crop: at 0.5 the frame
       * held the top-left quarter of the page at 1:1 and the canvas stretched that over the
       * whole stage (measured: a half-red, half-blue box captured solid red). At scale 1 the two
       * sizes are equal and nothing is resampled.
       */
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}" ` +
      `viewBox="0 0 ${liveW} ${liveH}" preserveAspectRatio="none" style="${attr(prepared.context.rootStyle)}">` +
      // extraCss last so a flattened shadow tree's rules win over anything the page declared
      // for the same host element — which is what the shadow boundary does in the live DOM.
      `<defs><style type="text/css"><![CDATA[${escapeCdata(`${css}\n${prepared.extraCss}`)}]]></style></defs>` +
      `<foreignObject width="100%" height="100%">` +
      // The wrapper stands in for the clone's real parent — inherited type, ground. context.ts.
      `<div xmlns="http://www.w3.org/1999/xhtml" style="${attr(prepared.context.wrapperStyle)}">${xml}</div>` +
      `</foreignObject></svg>`

    // data:, not blob: — see the header comment. This is load-bearing, not stylistic.
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    const img = new Image()
    img.src = url
    try {
      await img.decode()
    } catch (e) {
      /*
       * "The source image cannot be decoded." is all the browser says, whatever the cause. If
       * it was the markup, ask an XML parser where — see wellFormed.ts. Anything else (memory,
       * a genuinely broken resource) keeps the original error.
       */
      const why = explainUndecodable(svg)
      if (why) throw new Error(`Capture produced markup the SVG image cannot parse: ${why}`)
      throw e
    }

    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w
      scratch.height = h
    }
    // Under everything, the page's own Canvas colour: what a browser shows through a page that
    // paints no background. The scratch canvas is opaque and would otherwise show black.
    ctx!.fillStyle = prepared.context.ground || '#fff'
    ctx!.fillRect(0, 0, w, h)
    ctx!.drawImage(img, 0, 0, cw, ch)
    /*
     * The pad past the content rect (#75) repeats the content's edge rather than showing the
     * ground. The canvas never draws it, but the encoder codes it in the same blocks as the
     * last visible row, and a colour step there bleeds ringing back into the picture.
     */
    if (ch < h) ctx!.drawImage(scratch, 0, ch - 1, cw, 1, 0, ch, cw, h - ch)
    if (cw < w) ctx!.drawImage(scratch, cw - 1, 0, 1, h, cw, 0, w - cw, h)
    return new VideoFrame(scratch, { timestamp })
  }

  return {
    grab,
    report: () => last,
    dispose() {
      disposed = true
      if (ownsCache) cache.dispose()
      scratch.width = 0
      scratch.height = 0
    },
  }
}
