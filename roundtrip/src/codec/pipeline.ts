import type { CodecChoice, MoshConfig } from '../types.ts'
import { encodeOptionsFor, quantizerFor } from '../quantizer.ts'
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
  readonly stats: { encoded: number; decoded: number; dropped: number; moshed: number }
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
  const stats = { encoded: 0, decoded: 0, dropped: 0, moshed: 0 }

  const decoder = new VideoDecoder({
    output: (frame) => {
      stats.decoded++
      // Ownership passes to the consumer, which must close it. RoundTrip does so after paint.
      opts.onPicture(frame)
    },
    error: (e) => opts.onError(new Error('decoder: ' + e.message)),
  })
  decoder.configure({ codec: opts.codec, codedWidth: opts.width, codedHeight: opts.height })

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      stats.encoded++
      const decision = filter.decide(chunk.type as 'key' | 'delta', outputIndex)
      outputIndex++
      if (decision === 'drop') {
        stats.moshed++
        return
      }
      try {
        // Codec-specific setup (SPS/PPS for AVC, sequence header for AV1) arrives on the
        // first chunk's metadata. Without re-applying it the decoder cannot start.
        if (meta?.decoderConfig && decoder.state === 'configured') {
          decoder.configure(meta.decoderConfig)
        }
        decoder.decode(chunk)
      } catch (e) {
        opts.onError(e instanceof Error ? e : new Error(String(e)))
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
  if (opts.bitrateMode !== 'quantizer') cfg.bitrate = opts.bitrate ?? 200_000
  encoder.configure(cfg)

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
        const q = rawQuantizer ?? quantizerFor(opts.family, coarseness)
        const encOpts: VideoEncoderEncodeOptions =
          opts.bitrateMode === 'quantizer'
            ? { ...encodeOptionsFor(opts.family, q), keyFrame: wantsKeyframe(inputIndex) }
            : { keyFrame: wantsKeyframe(inputIndex) }
        encoder.encode(frame, encOpts)
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
