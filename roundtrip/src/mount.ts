import {
  createRoundTrip,
  prefersReducedMotion,
  type RoundTripController,
  type RoundTripCoreOptions,
  type RoundTripDials,
} from './core/createRoundTrip.ts'
import { ensureStyles } from './core/styles.ts'
import type { CaptureReport } from './types.ts'

/**
 * Mount the round tripper onto an existing element, with no framework.
 *
 * This is the path for a plain page — including one we do not own, via the IIFE bundle. It
 * takes over `target`'s existing children rather than rendering anything of its own: they are
 * moved (not cloned) into `.rt-content`, so every listener, every bit of form state and every
 * identity the host page holds on those nodes survives. Cloning would quietly break all three.
 */
export interface MountOptions extends Omit<RoundTripCoreOptions, 'content' | 'canvas'> {
  /** Bypass the pipeline entirely. Defaults to true under prefers-reduced-motion. */
  disabled?: boolean
  /** Extra class on the root, alongside `.rt-root`. */
  className?: string
  /**
   * Give the root a viewport-height box so the content scrolls INSIDE it. Defaults to true
   * when the target is <body>: with an unbounded root, `.rt-content`'s height resolves to auto
   * and the scroll container rule is inert, so the page would scroll the canvas away instead
   * of scrolling under it.
   */
  fullHeight?: boolean
}

export interface MountedRoundTrip {
  tune(dials: RoundTripDials): void
  /** The capture source's degradation report, if it has one. See RoundTripController. */
  report(): CaptureReport | undefined
  /** Stop, and put the host page's DOM back the way it was. */
  unmount(): void
}

export function mountRoundTrip(target: HTMLElement, opts: MountOptions = {}): MountedRoundTrip {
  const doc = target.ownerDocument
  ensureStyles(doc)

  const root = doc.createElement('div')
  root.className = opts.className ? `rt-root ${opts.className}` : 'rt-root'
  root.dataset.status = 'idle'

  const content = doc.createElement('div')
  content.className = 'rt-content'

  // aria-hidden + pointer-events:none are the whole accessibility and interaction story: the
  // canvas is a dumb display surface, never focusable and never hit-tested. The real DOM
  // underneath keeps receiving every event, which is the point of the piece.
  const canvas = doc.createElement('canvas')
  canvas.className = 'rt-canvas'
  canvas.setAttribute('aria-hidden', 'true')

  const status = doc.createElement('span')
  status.className = 'rt-status'
  status.setAttribute('role', 'status')

  const fullHeight = opts.fullHeight ?? target === doc.body
  if (fullHeight) {
    root.style.height = '100vh'
    root.style.height = '100dvh' // mobile: avoid the collapsing-toolbar jump
  }

  // Remember where the children came from so unmount() can put them back in order.
  const moved = Array.from(target.childNodes)
  for (const node of moved) content.appendChild(node)
  root.append(content, canvas, status)
  target.appendChild(root)

  let controller: RoundTripController | null = null

  const begin = () => {
    if (controller) return
    controller = createRoundTrip({
      ...opts,
      content,
      canvas,
      onStatus: (s, message) => {
        root.dataset.status = s
        status.textContent = s === 'running' ? '' : message
        opts.onStatus?.(s, message)
      },
    })
  }
  const end = () => {
    controller?.dispose()
    controller = null
    root.dataset.status = 'idle'
  }

  /*
   * Reduced motion is watched, not sampled once. The React wrapper re-renders when the query
   * flips, so the vanilla path has to do the same or the two entry points disagree about the
   * only accessibility setting the piece honours.
   */
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  const apply = () => {
    if (opts.disabled ?? prefersReducedMotion()) end()
    else begin()
  }
  mq?.addEventListener('change', apply)
  apply()

  return {
    tune: (dials) => controller?.tune(dials),
    report: () => controller?.report(),
    unmount() {
      mq?.removeEventListener('change', apply)
      end()
      // Children go back where they were. The injected <style data-rt> deliberately stays:
      // it is shared with any other mount in this document, and removing it would break them.
      for (const node of moved) target.appendChild(node)
      root.remove()
    },
  }
}
