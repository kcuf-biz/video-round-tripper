import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RoundTripProps } from './types.ts'
import {
  createRoundTrip,
  prefersReducedMotion,
  type RoundTripController,
  type RoundTripStatus,
} from './core/createRoundTrip.ts'
import { ensureStyles } from './core/styles.ts'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * Round-trips its children through a video codec and paints the result over them.
 *
 * OCCLUSION, NOT HIDING. The children stay fully rendered and fully interactive; the canvas
 * is an opaque sibling laid on top with pointer-events:none and aria-hidden. The browser's own
 * hit-testing delivers clicks, hover, focus, drag, selection and IME straight to the real
 * element underneath, so no event forwarding or coordinate mapping is needed — and synthesized
 * events could not drive :hover, :focus-visible or native selection anyway.
 *
 * This is NOT opacity:0. Transparency preserves the same interaction properties but breaks
 * capture: rasterizers apply opacity during paint, so a transparent subtree encodes as
 * transparent pixels. You cannot capture what you have made invisible.
 *
 * The effect that falls out of this is the point of the piece: hovering a button fires the
 * real :hover, which lands in the next captured frame, and reaches the viewer several frames
 * late and artifact-ridden.
 *
 * The loop itself lives in core/createRoundTrip.ts. What is left here is the React-shaped
 * part: refs, one effect whose dependency array expresses which options force a rebuild, and
 * the reduced-motion bypass.
 */
export function RoundTrip(props: RoundTripProps) {
  const {
    children,
    disabled,
    source,
    captureMode = 'continuous',
    captureFps = 30,
    codec = 'auto',
    codecPreference,
    coarseness,
    rawQuantizer,
    bitrate,
    declaredFramerate = 60,
    encodeScale = 1,
    gop,
    mosh,
    className,
    style,
  } = props

  const reduced = usePrefersReducedMotion()
  const off = disabled ?? reduced

  const contentRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controllerRef = useRef<RoundTripController | null>(null)
  const [status, setStatus] = useState<RoundTripStatus>('idle')
  const [message, setMessage] = useState<string>('')

  /*
   * A LAYOUT effect, not a passive one. The stylesheet used to be a `.css` import and was
   * therefore in the document before the first paint; injected from a passive effect it lands
   * one paint late, and for that frame `.rt-content` is not yet the scroll container — the
   * page flashes unclipped. useLayoutEffect runs before the browser paints, which closes it.
   */
  useLayoutEffect(() => {
    if (typeof document !== 'undefined') ensureStyles(document)
  }, [])

  useEffect(() => {
    if (off || !contentRef.current || !canvasRef.current) return
    const controller = createRoundTrip({
      content: contentRef.current,
      canvas: canvasRef.current,
      source,
      captureMode,
      codec,
      codecPreference,
      bitrate,
      declaredFramerate,
      encodeScale,
      // Read once at construction; the tune() effect below keeps them current afterwards.
      coarseness,
      rawQuantizer,
      gop,
      mosh,
      captureFps,
      onStatus: (s, m) => {
        setStatus(s)
        setMessage(m)
      },
    })
    controllerRef.current = controller
    return () => {
      controller.dispose()
      controllerRef.current = null
      setStatus('idle')
    }
    /*
     * Only the options the encoder is CONFIGURED with belong here: codec and dimensions are
     * fixed at configure() time, so changing them means a rebuild. The live dials are
     * deliberately absent — listing them would tear the pipeline down on every slider move and
     * the keyframe that a rebuild forces would wipe the accumulated error the piece is made
     * of. captureMode changes the event wiring, so it does rebuild, which is correct.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off, source, captureMode, codec, codecPreference, bitrate, declaredFramerate, encodeScale])

  useEffect(() => {
    controllerRef.current?.tune({ coarseness, rawQuantizer, gop, mosh, captureFps })
  }, [coarseness, rawQuantizer, gop, mosh, captureFps])

  if (off) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    )
  }

  return (
    <div className={`rt-root${className ? ' ' + className : ''}`} style={style} data-status={status}>
      <div className="rt-content" ref={contentRef}>
        {children}
      </div>
      {/*
        aria-hidden + pointer-events:none are the whole accessibility and interaction story.
        The canvas is a dumb display surface; it is never focusable and never hit-tested.
      */}
      <canvas className="rt-canvas" ref={canvasRef} aria-hidden="true" />
      <span className="rt-status" role="status">
        {status === 'running' ? '' : message}
      </span>
    </div>
  )
}
