import type { CaptureReport, CaptureSource, CodecChoice, CodecFamily, MoshConfig } from '../types.ts'
import { createForeignObjectSource } from '../capture/foreignObjectSource.ts'
import { probeCodec } from '../codec/probe.ts'
import { createPipeline, type Pipeline } from '../codec/pipeline.ts'
import { createPacer, encodeSize, isAwake, WAKE_MS } from '../frameBudget.ts'
import { resolveDials, type CodecDials } from '../codecs.ts'
import { ensureStyles } from './styles.ts'

/**
 * The capture -> encode -> mosh -> decode -> paint loop, with no framework in it.
 *
 * This used to live inside RoundTrip.tsx's main effect. It is out here because React is one
 * consumer of three: the component, `mountRoundTrip` for plain pages, and the IIFE bundle you
 * paste into someone else's page. All three need the same loop, the same teardown order and
 * the same frame-ownership discipline, and only one of them has hooks.
 *
 * The split is along the line React already drew for us. Anything the component's effect
 * dependency array lists is construction-time here (changing it means dispose + recreate,
 * because the encoder's codec and dimensions are fixed at configure() time); anything it
 * pushed through a ref is a live dial, tunable in place.
 */

export type RoundTripStatus = 'idle' | 'running' | 'unsupported' | 'error'

/**
 * The dials that can change without rebuilding the encoder.
 *
 * `undefined` means "not specified", NOT "use some default" — the caller's explicit value
 * always wins, and anything left undefined is filled in later against the codec family that
 * the probe actually picked. So do not collapse these to defaults on the way in.
 */
export interface RoundTripDials {
  coarseness?: number
  rawQuantizer?: number
  gop?: number | 'infinite'
  mosh?: MoshConfig | false
  captureFps?: number
}

export interface RoundTripCoreOptions extends RoundTripDials {
  /** The element to rasterize. Its size drives the encoder's dimensions. */
  content: HTMLElement
  /** The opaque overlay the decoded frames are painted onto. */
  canvas: HTMLCanvasElement
  /** Swap the capture strategy. Defaults to the foreignObject rasterizer. */
  source?: CaptureSource
  captureMode?: 'continuous' | 'on-interaction'
  /** A codec family ('avc'), a raw codec string, or 'auto' to probe. */
  codec?: string | 'auto'
  /** Family order to sweep when codec is 'auto'. Defaults to CODEC_PREFERENCE. */
  codecPreference?: readonly CodecFamily[]
  bitrate?: number
  declaredFramerate?: number
  encodeScale?: number
  /** Status transitions, for whatever is drawing the host element's [data-status]. */
  onStatus?: (status: RoundTripStatus, message: string) => void
  /**
   * What the probe picked and what the dials resolved to against it, once per pipeline build.
   *
   * This is the only way out for either answer. Both are decided after construction — the
   * probe is async and the per-codec table cannot be consulted until it answers — so a caller
   * that wants to SHOW the dials the encoder is really using (which is exactly the state a
   * bare <RoundTrip> is in) has no way to compute them. Re-probing on the side is an estimate,
   * not a reading: it does not know the stage's coded size.
   */
  onCodec?: (choice: CodecChoice, resolved: CodecDials) => void
}

export interface RoundTripController {
  /** Live-update the artifact dials. Anything else needs dispose() + a new controller. */
  tune(dials: RoundTripDials): void
  /**
   * What the capture source had to give up on for the most recent frame — blocked images,
   * fonts it could not inline, closed shadow roots, iframes.
   *
   * `undefined` means there is nothing to report ON, not that nothing was lost: the controller
   * has not built its source yet (the probe is async), it has been disposed, or a caller-
   * supplied source does not implement `report()`. A source that reports and lost nothing
   * returns zeroes. Those are different answers and the demo panels distinguish them.
   */
  report(): CaptureReport | undefined
  dispose(): void
}

/**
 * Identity, not just value, matters for the observed size: it used to feed a useMemo that fed
 * the component's main effect dependency array, and returning a fresh {w,h} on every
 * ResizeObserver callback tore down and rebuilt the entire encoder/decoder pipeline even when
 * nothing had actually changed — faster than a rebuild could ever paint a frame, so the canvas
 * simply stayed black. It typechecked and built cleanly; only the browser showed it. The guard
 * survives the move out of React because the underlying hazard (rebuild churn from a
 * no-op resize) is not a React problem.
 */
function sameSize(prev: { w: number; h: number } | null, w: number, h: number): boolean {
  return prev !== null && prev.w === w && prev.h === h
}

/** Shared by the React hook and by mountRoundTrip, so both bypass on the same condition. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

const WAKE_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focusin', 'input'] as const

export function createRoundTrip(opts: RoundTripCoreOptions): RoundTripController {
  const {
    content,
    canvas,
    source: externalSource,
    captureMode = 'continuous',
    codec = 'auto',
    codecPreference,
    bitrate,
    declaredFramerate = 60,
    encodeScale = 1,
    onStatus,
    onCodec,
  } = opts

  ensureStyles(content.ownerDocument)

  // Live dials, read at USE time. Never bake one of these into the capture loop's closure:
  // captureFps was read once when the pacer was built and dragging it silently did nothing
  // until some other prop forced a full rebuild.
  const dials: RoundTripDials = {
    coarseness: opts.coarseness,
    rawQuantizer: opts.rawQuantizer,
    gop: opts.gop,
    mosh: opts.mosh,
    captureFps: opts.captureFps,
  }

  /*
   * The family the probe picked, remembered so tune() can resolve the dials against the same
   * defaults the pipeline was built with. Null until the probe answers.
   */
  let family: CodecFamily | null = null

  let disposed = false
  let size: { w: number; h: number } | null = null
  let pipeline: Pipeline | null = null
  let source: CaptureSource | null = null
  let stopRun: (() => void) | null = null

  const setStatus = (status: RoundTripStatus, message: string) => {
    if (!disposed) onStatus?.(status, message)
  }

  function start(enc: { width: number; height: number }): void {
    if (typeof VideoEncoder === 'undefined') {
      setStatus('unsupported', 'WebCodecs VideoEncoder is not available in this browser.')
      return
    }

    canvas.width = enc.width
    canvas.height = enc.height
    const ctx = canvas.getContext('2d', { alpha: false })

    let cancelled = false
    let raf = 0
    let inFlight = false
    let detachWake: (() => void) | undefined

    const fail = (e: Error) => {
      if (cancelled) return
      setStatus('error', e.message)
    }

    ;(async () => {
      const choice = await probeCodec({
        width: enc.width,
        height: enc.height,
        framerate: declaredFramerate,
        codec: codec === 'auto' ? undefined : codec,
        codecPreference,
        bitrate,
      })
      if (cancelled) return
      if (!choice) {
        setStatus('unsupported', 'No supported encoder configuration on this device.')
        return
      }

      /*
       * Per-codec defaults are resolved HERE, and not a moment earlier: the family is not
       * known until the probe answers, and the whole point of the table is that a bare
       * <RoundTrip> should land somewhere worth looking at on whatever codec this device
       * turned out to admit to. Anything the caller stated explicitly wins.
       */
      family = choice.family
      const resolved = resolveDials(family, dials)
      // Reported here, next to the resolution itself, so what the caller is told and what the
      // pipeline is built with can never drift apart. Once per build, like onStatus's
      // 'running', and guarded the same way.
      if (!disposed) onCodec?.(choice, resolved)

      pipeline = createPipeline({
        ...choice,
        width: enc.width,
        height: enc.height,
        declaredFramerate,
        coarseness: resolved.coarseness,
        rawQuantizer: dials.rawQuantizer,
        bitrate,
        gop: resolved.gop,
        mosh: resolved.mosh,
        onPicture: (frame) => {
          try {
            if (!cancelled) ctx?.drawImage(frame, 0, 0, canvas.width, canvas.height)
          } finally {
            frame.close() // decoder output is ours to release; leaking here stalls everything
          }
        },
        onError: fail,
      })
      source =
        externalSource ?? createForeignObjectSource(content, { width: enc.width, height: enc.height })
      setStatus('running', `${choice.codec} · ${choice.hardwareAcceleration} · ${choice.bitrateMode}`)

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
      if (captureMode === 'on-interaction') {
        for (const ev of WAKE_EVENTS) content.addEventListener(ev, wake, { passive: true })
        // capture:true because scroll does not bubble — without it, scrolling the content
        // container itself (the normal case now) would never wake the loop.
        content.addEventListener('scroll', wake, { passive: true, capture: true })
        window.addEventListener('scroll', wake, { passive: true })
        detachWake = () => {
          for (const ev of WAKE_EVENTS) content.removeEventListener(ev, wake)
          content.removeEventListener('scroll', wake, { capture: true })
          window.removeEventListener('scroll', wake)
        }
      }

      const tick = async () => {
        if (cancelled) return
        raf = requestAnimationFrame(tick)
        const now = performance.now()
        if (!isAwake(captureMode, now, wokeAt, WAKE_MS)) return
        if (inFlight || !pacer.due(now, dials.captureFps ?? 30)) return
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

    stopRun = () => {
      cancelled = true
      cancelAnimationFrame(raf)
      detachWake?.()
      pipeline?.close()
      if (!externalSource) source?.dispose()
      pipeline = null
      source = null
      family = null
    }
  }

  function stop(): void {
    stopRun?.()
    stopRun = null
  }

  /*
   * Every encoder reconfigure forces a keyframe, which resets the accumulated error the piece
   * is made of — so a resize is debounced rather than followed. The guard is on the raw layout
   * size rather than on the post-encodeScale size deliberately: the two differ only in how
   * often a rebuild happens, and matching the old cadence exactly keeps this extraction
   * behaviour-preserving.
   */
  let debounce: number | undefined
  const measure = () => {
    const w = content.offsetWidth
    const h = content.offsetHeight
    if (sameSize(size, w, h)) return
    size = { w, h }
    stop()
    start(encodeSize(w, h, encodeScale))
  }
  const ro = new ResizeObserver(() => {
    window.clearTimeout(debounce)
    debounce = window.setTimeout(measure, 150)
  })
  ro.observe(content)
  measure()

  return {
    tune(next) {
      for (const key of ['coarseness', 'rawQuantizer', 'gop', 'mosh', 'captureFps'] as const) {
        if (key in next) (dials as Record<string, unknown>)[key] = next[key]
      }
      if (!pipeline || !family) return
      const resolved = resolveDials(family, dials)
      pipeline.tune({
        coarseness: resolved.coarseness,
        rawQuantizer: dials.rawQuantizer,
        gop: resolved.gop,
        mosh: resolved.mosh,
      })
    },
    report() {
      return source?.report?.()
    },
    dispose() {
      disposed = true
      window.clearTimeout(debounce)
      ro.disconnect()
      stop()
    },
  }
}
