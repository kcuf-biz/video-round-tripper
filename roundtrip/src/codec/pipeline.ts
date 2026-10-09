import type { CodecChoice, MoshConfig } from '../types.ts'
import { bitrateFor, encodeOptionsFor, quantizerFor, RATE_CONTROL } from '../quantizer.ts'
import { createMoshFilter, sameMoshConfig } from '../mosh.ts'
import { shouldDropForBackpressure } from '../frameBudget.ts'
import { framerateApplies } from '../framerate.ts'
import { createStarvationGuard } from '../starvation.ts'

/**
 * Encoder -> mosh filter -> decoder, as one unit.
 *
 * They are one unit because the mosh filter only makes sense between them and because the
 * decoder's priming invariant (its FIRST chunk must be a keyframe) is a property of the pair,
 * not of either half. Splitting them into two modules would put that invariant nowhere.
 *
 * VideoFrame LIFECYCLE IS THE THING TO GET RIGHT. Frames are refcounted native memory, not
 * garbage. A leaked frame stalls the encoder and then the pipeline. The rule here is: exactly
 * one owner per frame, and every path out of that ownership goes through .close() in a finally.
 */
export interface PipelineOptions extends CodecChoice {
  width: number
  height: number
  /** What we TELL the rate controller, which need not be what we feed it. */
  declaredFramerate: number
  coarseness: number
  rawQuantizer?: number
  bitrate?: number
  gop: number | 'infinite'
  mosh: MoshConfig | false
  /** Bitrate multiplier an earlier build of this stage already learned (see starvation.ts). */
  bitrateBoost?: number
  /** Called whenever the starvation guard raises the multiplier, so a rebuild can start there. */
  onBitrateBoost?: (boost: number) => void
  onPicture: (frame: VideoFrame) => void
  onError: (err: Error) => void
}

export interface Pipeline {
  /** Push one captured frame. Takes ownership: the frame is closed here, always. */
  push(frame: VideoFrame): void
  /** Live-update the artifact dials without tearing the pipeline down. */
  tune(next: Partial<Pick<PipelineOptions, 'coarseness' | 'rawQuantizer' | 'gop' | 'mosh' | 'declaredFramerate'>>): void
  close(): void
  readonly stats: {
    encoded: number
    decoded: number
    dropped: number
    moshed: number
    /** How many times the decoder died and was rebuilt. Under moshing this is expected. */
    decoderResets: number
  }
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  let { coarseness, rawQuantizer, gop, mosh, declaredFramerate } = opts
  let filter = createMoshFilter(mosh)
  // Two counters, deliberately. Keyframe REQUESTS are a property of the input stream
  // (which frame are we about to encode); mosh DECISIONS are a property of the output
  // stream (which chunk came back). Sharing one counter makes the GOP cadence lag behind
  // the input and go erratic as soon as backpressure starts dropping frames.
  let inputIndex = 0
  let outputIndex = 0
  let closed = false
  const stats = { encoded: 0, decoded: 0, dropped: 0, moshed: 0, decoderResets: 0 }

  /*
   * THE DECODER IS EXPECTED TO DIE, AND MUST BE ABLE TO COME BACK.
   *
   * A keyframe resets the reference-frame buffers. Drop one -- which is the entire point of
   * moshing -- and every delta after it references state the decoder never received. A
   * conformant decoder answers that with "Decoding error", and a VideoDecoder that errors is
   * CLOSED: every later decode() throws, so the picture stops forever after a single lovely
   * frame. That is not the piece failing, it is the piece working; the bug was having no way
   * back.
   *
   * So: rebuild the decoder, ask the encoder for a keyframe, and let that one keyframe
   * through regardless of what the mosh config says. The visible result is bloom -> collapse
   * -> snap back to clean -> bloom again, which is what datamoshing actually looks like. The
   * recovery is the aesthetic, not a patch over it.
   */
  let decoder = makeDecoder()
  let needKeyframe = false // ask the encoder for one
  let awaitingRecoveryKey = false // and let it past the filter when it arrives

  function makeDecoder(): VideoDecoder {
    const d = new VideoDecoder({
      output: (frame) => {
        stats.decoded++
        // Ownership passes to the consumer, which must close it. RoundTrip does so after paint.
        opts.onPicture(frame)
      },
      error: () => {
        // Expected under moshing. Do NOT surface as an error; arm the recovery instead.
        stats.decoderResets++
        needKeyframe = true
        awaitingRecoveryKey = true
      },
    })
    d.configure({ codec: opts.codec, codedWidth: opts.width, codedHeight: opts.height })
    return d
  }

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      stats.encoded++
      starvation.output()
      const isKey = (chunk.type as 'key' | 'delta') === 'key'

      let decision: 'pass' | 'drop'
      if (awaitingRecoveryKey) {
        // Deltas are useless to a decoder with no reference. Hold until the keyframe lands.
        if (!isKey) {
          stats.moshed++
          outputIndex++
          return
        }
        decision = 'pass'
        awaitingRecoveryKey = false
      } else {
        decision = filter.decide(chunk.type as 'key' | 'delta', outputIndex)
      }
      outputIndex++
      if (decision === 'drop') {
        stats.moshed++
        return
      }
      try {
        if (decoder.state === 'closed') decoder = makeDecoder()
        // Codec-specific setup (SPS/PPS for AVC, sequence header for AV1) arrives on the
        // first chunk's metadata. Without re-applying it the decoder cannot start.
        if (meta?.decoderConfig && decoder.state === 'configured') {
          decoder.configure(meta.decoderConfig)
        }
        decoder.decode(chunk)
      } catch {
        // A decode that throws means the decoder is gone; recover on the next keyframe
        // rather than tearing the whole pipeline down.
        stats.decoderResets++
        needKeyframe = true
        awaitingRecoveryKey = true
      }
    },
    error: (e) => opts.onError(new Error('encoder: ' + e.message)),
  })

  const cfg: VideoEncoderConfig = {
    codec: opts.codec,
    width: opts.width,
    height: opts.height,
    framerate: opts.declaredFramerate,
    latencyMode: 'realtime',
    hardwareAcceleration: opts.hardwareAcceleration,
    bitrateMode: opts.bitrateMode,
  }
  /*
   * COARSENESS AS A BITRATE (#72), for AV1 and VP9 only: the families whose RATE_CONTROL is
   * 'constant', because their encoders answer a starved rate with genuinely degraded frames.
   * #91 extended it to any constant-mode stream, which put AVC in a bitrate mode (a device with
   * no quantizer mode) at ~50kbps at phone size, and hardware AVC answers that by SKIPPING
   * frames: one painted frame every 2-3s on the author's iPhone. It never got uglier, only slower. So
   * AVC/HEVC in a bitrate mode are back at a flat 200kbps, which is what ran smoothly on that
   * phone before #91 (the author, 2026-10-09).
   * Changing it means reconfiguring the encoder, which forces a keyframe, so tune() only marks
   * it and push() applies it at most every RETARGET_MS: a dragged slider would otherwise emit a
   * keyframe per pixel of travel.
   */
  const bitrateDial =
    opts.bitrateMode === 'constant' && RATE_CONTROL[opts.family] === 'constant' && opts.bitrate === undefined
  /*
   * STARVATION BACK-OFF (starvation.ts), a safety net. In a bitrate mode with no bitrate pinned
   * by the caller, whatever we ask for is multiplied by what the guard has learned: an encoder
   * that still skips frames at the rate above is given more until it stops. A pinned bitrate is
   * the caller's to keep, starving or not.
   */
  const guarded = opts.bitrateMode !== 'quantizer' && opts.bitrate === undefined
  const starvation = createStarvationGuard({ initialBoost: guarded ? opts.bitrateBoost : 1 })
  let boost = starvation.boost
  const baseBitrate = () => (bitrateDial ? bitrateFor(coarseness, opts.width, opts.height) : 200_000)
  const targetBitrate = () => (opts.bitrate !== undefined ? opts.bitrate : Math.round(baseBitrate() * boost))
  if (opts.bitrateMode !== 'quantizer') cfg.bitrate = targetBitrate()
  encoder.configure(cfg)
  const RETARGET_MS = 250
  let lastRetarget = 0

  /*
   * declaredFramerate rides the same reconfigure (#70): in a bitrate mode it is the per-frame
   * budget's divisor, so changing it live is exactly as cheap as changing the bitrate — one
   * configure(), one forced keyframe, rate-limited the same way. In quantizer mode it is never
   * applied, because it would cost that keyframe and buy nothing; the core warns instead.
   */
  const framerateDial = framerateApplies(opts.bitrateMode)

  function retarget(): void {
    const wantBitrate = guarded ? targetBitrate() : cfg.bitrate
    const wantFramerate = framerateDial ? declaredFramerate : cfg.framerate
    if (wantBitrate === cfg.bitrate && wantFramerate === cfg.framerate) return
    const now = performance.now()
    if (now - lastRetarget < RETARGET_MS) return
    cfg.bitrate = wantBitrate
    cfg.framerate = wantFramerate
    lastRetarget = now
    encoder.configure(cfg)
  }

  function wantsKeyframe(i: number): boolean {
    if (i === 0) return true
    if (gop === 'infinite') return false
    return typeof gop === 'number' && gop > 0 && i % gop === 0
  }

  return {
    stats,
    push(frame) {
      if (closed) {
        frame.close()
        return
      }
      try {
        // Drop rather than queue. A dropped frame widens the inter-frame delta, which makes
        // the artifacts better — the backpressure policy and the aesthetic agree here.
        // The guard looks BEFORE backpressure, and a frame dropped for backpressure counts as
        // one in with nothing out: a starving encoder holds frames, its queue fills, and every
        // later frame is dropped here. Checked after the drop, the guard never ran until the
        // encoder coughed up its first frame, 3.1s in (measured), which was the whole pause.
        const now = performance.now()
        if (guarded) {
          const next = starvation.check(now)
          if (next !== boost) {
            boost = next
            opts.onBitrateBoost?.(boost)
          }
        }
        if (shouldDropForBackpressure(encoder.encodeQueueSize)) {
          stats.dropped++
          if (guarded) starvation.input(now)
          return
        }
        retarget()
        const q = rawQuantizer ?? quantizerFor(opts.family, coarseness)
        const keyFrame = needKeyframe || wantsKeyframe(inputIndex)
        const encOpts: VideoEncoderEncodeOptions =
          opts.bitrateMode === 'quantizer'
            ? { ...encodeOptionsFor(opts.family, q), keyFrame }
            : { keyFrame }
        encoder.encode(frame, encOpts)
        if (guarded) starvation.input(now)
        if (keyFrame) needKeyframe = false
        inputIndex++
      } catch (e) {
        opts.onError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        frame.close() // the one owner, always released
      }
    },
    tune(next) {
      if (next.coarseness !== undefined) coarseness = next.coarseness
      if (next.rawQuantizer !== undefined) rawQuantizer = next.rawQuantizer
      if (next.gop !== undefined) gop = next.gop
      if (next.declaredFramerate !== undefined) declaredFramerate = next.declaredFramerate
      if (next.mosh !== undefined && !sameMoshConfig(mosh, next.mosh)) {
        /*
         * Two things are load-bearing here.
         *
         * 1. The value comparison. A React caller naturally hands us a fresh config object on
         *    every render; rebuilding the filter each time would restart its PRNG and make
         *    dropDeltaChance non-reproducible.
         * 2. Carrying `filter.primed` across the swap. Priming belongs to the decoder, which
         *    is still running and still primed. Handing a new filter a false `primed` makes it
         *    drop every chunk until it sees a keyframe — and under `gop: 'infinite'` there is
         *    never another one, so the picture freezes permanently and looks like a crash.
         *
         * Deliberately NOT resetting the counters or forcing a keyframe: turning moshing on
         * should bloom from wherever the stream currently is, not from a clean slate.
         */
        filter = createMoshFilter(next.mosh, filter.primed)
        mosh = next.mosh
      }
    },
    close() {
      closed = true
      try {
        if (encoder.state !== 'closed') encoder.close()
      } catch {
        /* already torn down */
      }
      try {
        if (decoder.state !== 'closed') decoder.close()
      } catch {
        /* already torn down */
      }
    },
  }
}
