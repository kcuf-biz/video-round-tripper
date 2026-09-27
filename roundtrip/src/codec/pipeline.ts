import type { CodecChoice, MoshConfig } from '../types.ts'
import { bitrateFor, encodeOptionsFor, quantizerFor, RATE_CONTROL } from '../quantizer.ts'
import { createMoshFilter, sameMoshConfig } from '../mosh.ts'
import { shouldDropForBackpressure } from '../frameBudget.ts'

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
  onPicture: (frame: VideoFrame) => void
  onError: (err: Error) => void
}

export interface Pipeline {
  /** Push one captured frame. Takes ownership: the frame is closed here, always. */
  push(frame: VideoFrame): void
  /** Live-update the artifact dials without tearing the pipeline down. */
  tune(next: Partial<Pick<PipelineOptions, 'coarseness' | 'rawQuantizer' | 'gop' | 'mosh'>>): void
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
  let { coarseness, rawQuantizer, gop, mosh } = opts
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
   * COARSENESS AS A BITRATE (#72). When the family's dial is a starved constant bitrate and the
   * probe actually got that mode, coarseness sets the bitrate — unless the caller pinned one.
   * Changing it means reconfiguring the encoder, which forces a keyframe, so tune() only marks
   * it and push() applies it at most every RETARGET_MS: a dragged slider would otherwise emit a
   * keyframe per pixel of travel.
   */
  const bitrateDial = opts.bitrateMode === 'constant' && RATE_CONTROL[opts.family] === 'constant' && opts.bitrate === undefined
  const targetBitrate = () => bitrateFor(coarseness, opts.width, opts.height)
  if (opts.bitrateMode !== 'quantizer') cfg.bitrate = bitrateDial ? targetBitrate() : (opts.bitrate ?? 200_000)
  encoder.configure(cfg)
  const RETARGET_MS = 250
  let lastRetarget = 0

  function retarget(): void {
    if (!bitrateDial) return
    const want = targetBitrate()
    const now = performance.now()
    if (want === cfg.bitrate || now - lastRetarget < RETARGET_MS) return
    cfg.bitrate = want
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
        if (shouldDropForBackpressure(encoder.encodeQueueSize)) {
          stats.dropped++
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
