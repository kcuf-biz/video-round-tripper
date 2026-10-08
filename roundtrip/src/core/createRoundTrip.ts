import type { CaptureReport, CaptureSource, CodecChoice, CodecFamily, MoshConfig } from '../types.ts'
import { createForeignObjectSource } from '../capture/foreignObjectSource.ts'
import { probeCodec } from '../codec/probe.ts'
import { createPipeline, type Pipeline } from '../codec/pipeline.ts'
import { contentSize, createPacer, createRateMeter, encodeSize, isAwake, WAKE_MS } from '../frameBudget.ts'
import { resolveDials, type CodecDials } from '../codecs.ts'
import { ensureStyles } from './styles.ts'
import { createFramerateNotice } from '../framerate.ts'

/** Module-level so it speaks once per page, not once per controller. See framerate.ts. */
const noticeFramerate = createFramerateNotice()

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
  /**
   * The lie told to the rate controller: its per-frame budget is bitrate / this, while capture
   * feeds it captureFps. Defaults to 60.
   *
   * BITRATE MODES ONLY (#70). Under quantizer mode — avc/hevc's default — there is no budget
   * to divide and it does nothing; setting it there, at construction or through tune(), logs
   * one console warning per page and is otherwise ignored. In a bitrate mode tune() applies it
   * live, at the cost of the one keyframe any encoder reconfigure forces.
   */
  declaredFramerate?: number
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
  /** Pins the bitrate in the bitrate modes instead of deriving it from coarseness. See RoundTripProps. */
  bitrate?: number
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

/**
 * What the controller is doing right now, for a page that wants to SHOW it (#79).
 *
 * The marketing page's "Your codec" panel used to read all of this from outside — codec from
 * onCodec, sizes from the overlay canvas plus encodeSize(), paint rate by wrapping drawImage on
 * the canvas's 2D context — which broke silently whenever the core changed an internal (#75
 * moved the canvas from the encode size to the content size). Everything here is read off the
 * running build, so a page never has to know how the stage is put together.
 *
 * PER BUILD: every rebuild (a resize, after the 150ms debounce) starts a fresh encoder and
 * decoder, so the counters restart at 0 and `builds` goes up. That is the honest reading — a
 * resize forces a keyframe and resets everything the piece had accumulated.
 */
export interface RoundTripStats {
  /** Same values onStatus reports: 'running' only once this build has painted a frame. */
  status: RoundTripStatus
  /** What the probe picked for this build; null until it answers, or if nothing was supported. */
  codec: CodecChoice | null
  /** The encoder's frame: even, for 4:2:0. */
  encodeSize: { width: number; height: number } | null
  /** The part of the encode frame the content occupies, and the canvas's backing size. */
  contentSize: { width: number; height: number } | null
  /** Frames the encoder emitted, the decoder emitted, backpressure dropped, and mosh withheld. */
  encoded: number
  decoded: number
  dropped: number
  moshed: number
  /** Times the decoder died and was rebuilt; expected under moshing on av1/vp9. */
  decoderResets: number
  /** Frames actually drawn onto the canvas this build. */
  painted: number
  /**
   * Painted frames per second, MEASURED over the last second. Not captureFps: backpressure,
   * moshing, on-interaction idling and a hidden tab all make the two differ, and it decays to
   * 0 on its own when painting stops.
   */
  paintFps: number
  /** How many times the pipeline has been built — 1 plus every resize-triggered rebuild. */
  builds: number
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
  /** A snapshot of what the controller is doing. Cheap: poll it. See RoundTripStats. */
  stats(): RoundTripStats
  dispose(): void
}

/** The stats of a controller that has not built anything — also what an unmounted handle reads. */
export function idleStats(): RoundTripStats {
  return {
    status: 'idle',
    codec: null,
    encodeSize: null,
    contentSize: null,
    encoded: 0,
    decoded: 0,
    dropped: 0,
    moshed: 0,
    decoderResets: 0,
    painted: 0,
    paintFps: 0,
    builds: 0,
  }
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
    declaredFramerate: opts.declaredFramerate,
  }
  const framerate = () => dials.declaredFramerate ?? 60

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

  // What stats() reads. Written where each fact is decided, never recomputed on read.
  let currentStatus: RoundTripStatus = 'idle'
  let currentChoice: CodecChoice | null = null
  let currentSizes: { enc: { width: number; height: number }; view: { width: number; height: number } } | null = null
  let paintedCount = 0
  let builds = 0
  const paintMeter = createRateMeter()

  const setStatus = (status: RoundTripStatus, message: string) => {
    if (disposed) return
    currentStatus = status
    onStatus?.(status, message)
  }

  function start(enc: { width: number; height: number }, view: { width: number; height: number }): void {
    if (typeof VideoEncoder === 'undefined') {
      setStatus('unsupported', 'WebCodecs VideoEncoder is not available in this browser.')
      return
    }

    // Resizing the canvas clears it, so a rebuild is back to "nothing painted": show the live
    // content until this build's first frame rather than a blank overlay.
    setStatus('idle', '')
    builds++
    currentSizes = { enc, view }
    currentChoice = null
    paintedCount = 0
    paintMeter.reset()
    /*
     * The canvas backing store is the CONTENT rect, not the encode frame, and only that rect of
     * each decoded frame is drawn. Backlog #75: at the encode size an odd display height put
     * the encoder's pad row on the canvas's last CSS pixel — 842 rows stretched into an 841px
     * box, a dark line along the bottom (on iOS, just above the toolbar).
     */
    canvas.width = view.width
    canvas.height = view.height
    const ctx = canvas.getContext('2d', { alpha: false })

    let cancelled = false
    let painted = false
    let runningMessage = ''
    let raf = 0
    let inFlight = false
    let detachWake: (() => void) | undefined

    // The status line only has room for the message, which on its own can be untraceable
    // ("Cannot read properties of undefined (reading 'startsWith')" took a stack from a
    // special build to find). So the whole error goes to the console as well, once per distinct
    // message per build: a capture failure repeats every frame and would flood it.
    const logged = new Set<string>()
    const fail = (e: Error) => {
      if (cancelled) return
      if (!logged.has(e.message)) {
        logged.add(e.message)
        console.error('[round-tripper]', e)
      }
      setStatus('error', e.message)
    }

    ;(async () => {
      const choice = await probeCodec({
        width: enc.width,
        height: enc.height,
        framerate: framerate(),
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
      currentChoice = choice
      const resolved = resolveDials(family, dials)
      // Reported here, next to the resolution itself, so what the caller is told and what the
      // pipeline is built with can never drift apart. Once per build, like onStatus's
      // 'running', and guarded the same way.
      if (!disposed) onCodec?.(choice, resolved)
      // Only a value the caller actually stated; the default is not theirs to be warned about.
      if (dials.declaredFramerate !== undefined) noticeFramerate(choice)

      pipeline = createPipeline({
        ...choice,
        width: enc.width,
        height: enc.height,
        declaredFramerate: framerate(),
        coarseness: resolved.coarseness,
        rawQuantizer: dials.rawQuantizer,
        bitrate,
        gop: resolved.gop,
        mosh: resolved.mosh,
        onPicture: (frame) => {
          try {
            if (!cancelled) {
              ctx?.drawImage(frame, 0, 0, view.width, view.height, 0, 0, canvas.width, canvas.height)
              paintedCount++
              paintMeter.mark(performance.now())
              if (!painted) {
                painted = true
                setStatus('running', runningMessage)
              }
            }
          } finally {
            frame.close() // decoder output is ours to release; leaking here stalls everything
          }
        },
        onError: fail,
      })
      source =
        externalSource ??
        createForeignObjectSource(content, {
          width: enc.width,
          height: enc.height,
          contentWidth: view.width,
          contentHeight: view.height,
        })
      /*
       * NOT 'running' yet. The canvas is shown from 'running' on, and until the first decoded
       * frame is drawn it holds nothing — so flipping here put a black overlay over the page
       * for as long as the first capture took, and (backlog #62) a black canvas reading
       * 'running' sent whoever was debugging a capture that could never decode off towards the
       * codec. onPicture flips it on the first real paint.
       */
      runningMessage = `${choice.codec} · ${choice.hardwareAcceleration} · ${choice.bitrateMode}`

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
    start(encodeSize(w, h, encodeScale), contentSize(w, h, encodeScale))
  }
  const ro = new ResizeObserver(() => {
    window.clearTimeout(debounce)
    debounce = window.setTimeout(measure, 150)
  })
  ro.observe(content)
  measure()

  return {
    tune(next) {
      for (const key of ['coarseness', 'rawQuantizer', 'gop', 'mosh', 'captureFps', 'declaredFramerate'] as const) {
        if (key in next) (dials as Record<string, unknown>)[key] = next[key]
      }
      if (!pipeline || !family || !currentChoice) return
      // Before the probe answers there is no mode to judge it by; the build above warns then.
      if (next.declaredFramerate !== undefined) noticeFramerate(currentChoice)
      const resolved = resolveDials(family, dials)
      pipeline.tune({
        coarseness: resolved.coarseness,
        rawQuantizer: dials.rawQuantizer,
        gop: resolved.gop,
        mosh: resolved.mosh,
        declaredFramerate: framerate(),
      })
    },
    report() {
      return source?.report?.()
    },
    stats() {
      const p = pipeline?.stats
      return {
        status: currentStatus,
        codec: currentChoice,
        encodeSize: currentSizes ? { ...currentSizes.enc } : null,
        contentSize: currentSizes ? { ...currentSizes.view } : null,
        encoded: p?.encoded ?? 0,
        decoded: p?.decoded ?? 0,
        dropped: p?.dropped ?? 0,
        moshed: p?.moshed ?? 0,
        decoderResets: p?.decoderResets ?? 0,
        painted: paintedCount,
        paintFps: paintMeter.rate(performance.now()),
        builds,
      }
    },
    dispose() {
      disposed = true
      window.clearTimeout(debounce)
      ro.disconnect()
      stop()
    },
  }
}
