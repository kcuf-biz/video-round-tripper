import { useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureSource, RoundTripProps } from './types.ts'
import { createForeignObjectSource } from './capture/foreignObjectSource.ts'
import { probeCodec } from './codec/probe.ts'
import { createPipeline, type Pipeline } from './codec/pipeline.ts'
import { createPacer, encodeSize, isAwake, WAKE_MS } from './frameBudget.ts'
import './roundtrip.css'

/**
 * Identity, not just value, matters for `size`: it feeds a useMemo that feeds the main
 * effect's dependency array. Returning a fresh {w,h} on every ResizeObserver callback tears
 * down and rebuilds the entire encoder/decoder pipeline even when nothing actually changed —
 * and because a rebuild takes longer than the observer's debounce, the loop never survives
 * long enough to paint a frame. It typechecks and builds cleanly; only the browser shows it.
 */
function sameSize(prev: { w: number; h: number } | null, w: number, h: number): boolean {
  return prev !== null && prev.w === w && prev.h === h
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
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
 */
export function RoundTrip(props: RoundTripProps) {
  const {
    children,
    disabled,
    source: externalSource,
    captureMode = 'continuous',
    captureFps = 30,
    codec = 'auto',
    coarseness = 0.75,
    rawQuantizer,
    bitrate,
    declaredFramerate = 60,
    encodeScale = 1,
    gop = 'infinite',
    mosh = false,
    className,
    style,
  } = props

  const reduced = usePrefersReducedMotion()
  const off = disabled ?? reduced

  const contentRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pipeRef = useRef<Pipeline | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'unsupported' | 'error'>('idle')
  const [message, setMessage] = useState<string>('')

  // Dials that can change without rebuilding the encoder. Kept in a ref so the capture loop
  // reads current values without being re-created (and without stale-closure bugs).
  const dials = useRef({ coarseness, rawQuantizer, gop, mosh, captureFps })
  dials.current = { coarseness, rawQuantizer, gop, mosh, captureFps }
  useEffect(() => {
    pipeRef.current?.tune({ coarseness, rawQuantizer, gop, mosh })
  }, [coarseness, rawQuantizer, gop, mosh])

  // Anything in this key forces a full teardown: the encoder's dimensions and codec are fixed
  // at configure() time, so they cannot be tuned in place.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = contentRef.current
    if (!el || off) return
    let t: number | undefined
    const ro = new ResizeObserver(() => {
      // Debounced: every reconfigure forces a keyframe, which visibly "cleans up" the image
      // and throws away the accumulated error that the piece is made of.
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        setSize((prev) => sameSize(prev, el.offsetWidth, el.offsetHeight)
          ? prev
          : { w: el.offsetWidth, h: el.offsetHeight })
      }, 150)
    })
    ro.observe(el)
    setSize((prev) => sameSize(prev, el.offsetWidth, el.offsetHeight)
      ? prev
      : { w: el.offsetWidth, h: el.offsetHeight })
    return () => {
      window.clearTimeout(t)
      ro.disconnect()
    }
  }, [off])

  const enc = useMemo(
    () => (size ? encodeSize(size.w, size.h, encodeScale) : null),
    [size, encodeScale],
  )

  useEffect(() => {
    if (off || !enc || !contentRef.current || !canvasRef.current) return
    if (typeof VideoEncoder === 'undefined') {
      setStatus('unsupported')
      setMessage('WebCodecs VideoEncoder is not available in this browser.')
      return
    }

    const content = contentRef.current
    const canvas = canvasRef.current
    canvas.width = enc.width
    canvas.height = enc.height
    const ctx = canvas.getContext('2d', { alpha: false })

    let cancelled = false
    let raf = 0
    let source: CaptureSource | null = null
    let pipeline: Pipeline | null = null
    let inFlight = false
    let detachWake: (() => void) | undefined

    const fail = (e: Error) => {
      if (cancelled) return
      setStatus('error')
      setMessage(e.message)
    }

    ;(async () => {
      const choice = await probeCodec({
        width: enc.width,
        height: enc.height,
        framerate: declaredFramerate,
        codec: codec === 'auto' ? undefined : codec,
        bitrate,
      })
      if (cancelled) return
      if (!choice) {
        setStatus('unsupported')
        setMessage('No supported encoder configuration on this device.')
        return
      }

      pipeline = createPipeline({
        ...choice,
        width: enc.width,
        height: enc.height,
        declaredFramerate,
        coarseness: dials.current.coarseness,
        rawQuantizer: dials.current.rawQuantizer,
        bitrate,
        gop: dials.current.gop,
        mosh: dials.current.mosh,
        onPicture: (frame) => {
          try {
            if (!cancelled) ctx?.drawImage(frame, 0, 0, canvas.width, canvas.height)
          } finally {
            frame.close() // decoder output is ours to release; leaking here stalls everything
          }
        },
        onError: fail,
      })
      pipeRef.current = pipeline
      source = externalSource ?? createForeignObjectSource(content, { width: enc.width, height: enc.height })
      setStatus('running')
      setMessage(`${choice.codec} · ${choice.hardwareAcceleration} · ${choice.bitrateMode}`)

      const pacer = createPacer()

      /*
       * 'on-interaction' exists for the case where the rasterizer is too slow to run
       * continuously on a given page. It captures for a short window after anything actually
       * changes — pointer, scroll, focus, keystroke — and otherwise lets the last decoded
       * frame stand. The page then visibly macroblocks while you touch it and freezes, still
       * artifact-ridden, when you stop.
       */
      let wokeAt = performance.now()
      const wake = () => {
        wokeAt = performance.now()
      }
      const WAKE_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focusin', 'input'] as const
      if (captureMode === 'on-interaction') {
        for (const ev of WAKE_EVENTS) content.addEventListener(ev, wake, { passive: true })
        window.addEventListener('scroll', wake, { passive: true })
        detachWake = () => {
          for (const ev of WAKE_EVENTS) content.removeEventListener(ev, wake)
          window.removeEventListener('scroll', wake)
        }
      }

      const tick = async () => {
        if (cancelled) return
        raf = requestAnimationFrame(tick)
        const now = performance.now()
        if (!isAwake(captureMode, now, wokeAt, WAKE_MS)) return
        if (inFlight || !pacer.due(now, dials.current.captureFps)) return
        pacer.mark(now)
        inFlight = true
        try {
          const frame = await source!.grab(Math.round(now * 1000))
          if (cancelled) {
            frame.close()
            return
          }
          pipeline!.push(frame) // push() always closes the frame
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)))
        } finally {
          inFlight = false
        }
      }
      raf = requestAnimationFrame(tick)
    })().catch(fail)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      detachWake?.()
      pipeline?.close()
      if (!externalSource) source?.dispose()
      pipeRef.current = null
    }
    // captureMode is read via dials for cadence; a change of MODE rebuilds, which is correct.
  }, [off, enc, codec, declaredFramerate, bitrate, externalSource, captureMode])

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
