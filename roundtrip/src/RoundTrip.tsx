import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CaptureSource, CodecChoice, CodecFamily, MoshConfig } from './types.ts'
import type { CodecDials } from './codecs.ts'
import {
  createRoundTrip,
  prefersReducedMotion,
  type RoundTripController,
  type RoundTripStatus,
} from './core/createRoundTrip.ts'
import { readHandle, type RoundTripHandle } from './core/handle.ts'
import { ensureStyles } from './core/styles.ts'

/**
 * Props for <RoundTrip>. Lives here rather than in types.ts because it is the only public type
 * that names React's, and types.ts has to stay importable by a consumer who has no React.
 */
export interface RoundTripProps {
  children: ReactNode

  /** Bypass the whole pipeline and render children plainly. Defaults to true under prefers-reduced-motion. */
  disabled?: boolean

  /** Swap the capture strategy. Defaults to the foreignObject rasterizer. */
  source?: CaptureSource

  /** 'continuous' runs a loop; 'on-interaction' only captures after scroll/pointer/resize settle. */
  captureMode?: 'continuous' | 'on-interaction'
  /** Target capture cadence. Actual will be lower and uneven — that is the aesthetic, not a bug. */
  captureFps?: number

  /**
   * A codec FAMILY ('avc' | 'hevc' | 'av1' | 'vp9'), an explicit codec string, or 'auto' to
   * probe at runtime. A family is the useful form: the concrete string carries a level, and
   * the level has to be derived from the coded size or the encoder refuses it outright.
   */
  codec?: CodecFamily | (string & {}) | 'auto'
  /** Family order to sweep when codec is 'auto'. Defaults to CODEC_PREFERENCE (avc first). */
  codecPreference?: readonly CodecFamily[]
  /**
   * THE dial. 0 = nearly clean, 1 = falls apart. Mapped to a per-codec QP in ./quantizer.ts.
   * Left undefined, it takes the picked family's default from ./codecs.ts.
   */
  coarseness?: number
  /** Bypass `coarseness` with a raw per-codec quantizer value. Advanced. */
  rawQuantizer?: number
  /** Used only when quantizer mode is unsupported. Deliberately starved. */
  bitrate?: number
  /**
   * The lie. Configure the rate controller for this framerate while feeding it far fewer
   * frames, so it budgets tiny frames and starves itself. Independent of captureFps.
   */
  declaredFramerate?: number
  /** 0..1 — encode below display resolution and let the canvas upscale. Cheap, very effective. */
  encodeScale?: number

  /**
   * Frames between keyframes. 'infinite' = keyFrame:true on frame 0 only, never again.
   * Left undefined, it takes the picked family's default from ./codecs.ts.
   */
  gop?: number | 'infinite'
  /**
   * Drop chunks between encoder and decoder. See MoshConfig.
   * Left undefined, it takes the picked family's default from ./codecs.ts — which is a mosh
   * for AVC/HEVC and none for AV1/VP9, where it does not produce the look.
   */
  mosh?: MoshConfig | false

  /**
   * Called once per pipeline build with the codec the probe picked and the dials resolved
   * against it — i.e. the values actually being encoded with, including every one you left
   * undefined. A panel that wants to display them, or to take over from them, has no other
   * source: the family is not known until the async probe answers.
   */
  onCodec?: (choice: CodecChoice, resolved: CodecDials) => void

  className?: string
  style?: CSSProperties
}

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
 *
 * A ref reads what the stage is doing: `ref.current.stats()` / `.report()`, see
 * RoundTripHandle. The handle is stable for the component's life and reads the controller of
 * the moment, so it survives rebuilds; poll it rather than keeping what it returns.
 * forwardRef rather than ref-as-prop because the peer range still includes React 18.
 */
export const RoundTrip = forwardRef<RoundTripHandle, RoundTripProps>(function RoundTrip(props, ref) {
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
    onCodec,
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

  // Empty deps: the handle closes over the REF, not the controller, so it never goes stale.
  useImperativeHandle(ref, () => readHandle(() => controllerRef.current), [])

  /*
   * Through a ref, never the dependency array below. A caller writes this as an inline arrow,
   * so its identity is fresh on every render; listing it would rebuild the pipeline — and
   * force the keyframe a rebuild forces — every time the parent re-rendered, which is every
   * time the panel it feeds updated. Same rule as the live dials: only configure()-time
   * options are dependencies.
   */
  const onCodecRef = useRef(onCodec)
  useEffect(() => {
    onCodecRef.current = onCodec
  })

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
      onCodec: (choice, resolved) => onCodecRef.current?.(choice, resolved),
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
})
