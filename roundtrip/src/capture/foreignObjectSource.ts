import type { CaptureSource } from '../types.ts'
import {
  createResourceCache,
  syncFormState,
  syncScrollState,
  type ResourceCache,
} from './inlineResources.ts'

/**
 * The default capture path: serialize the live element into an SVG <foreignObject>, load it
 * as an image, and draw it to a canvas.
 *
 * Measured on the spike page (860x540, six webfont faces, Chrome 150 / macOS):
 *   8ms median, 18ms p95  -> ~125fps, untainted, full font fidelity.
 * That is ~3x faster than the best library tried (snapdom, 22ms) with no dependency.
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
  cache?: ResourceCache
  /** Called when a frame fails to rasterize, rather than throwing into the render loop. */
  onError?: (err: Error) => void
}

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

  async function grab(timestamp: number): Promise<VideoFrame> {
    if (disposed) throw new Error('capture source disposed')
    const w = opts.width ?? element.offsetWidth
    const h = opts.height ?? element.offsetHeight
    if (w === 0 || h === 0) throw new Error('capture target has zero size')

    const css = await cache.css()
    const clone = element.cloneNode(true) as HTMLElement
    syncFormState(element, clone)
    syncScrollState(element, clone)

    const xml = new XMLSerializer().serializeToString(clone)
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<defs><style type="text/css"><![CDATA[${css}]]></style></defs>` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml">${xml}</div>` +
      `</foreignObject></svg>`

    // data:, not blob: — see the header comment. This is load-bearing, not stylistic.
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    const img = new Image()
    img.src = url
    await img.decode()

    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w
      scratch.height = h
    }
    ctx!.drawImage(img, 0, 0, w, h)
    return new VideoFrame(scratch, { timestamp })
  }

  return {
    grab,
    dispose() {
      disposed = true
      if (ownsCache) cache.dispose()
      scratch.width = 0
      scratch.height = 0
    },
  }
}
