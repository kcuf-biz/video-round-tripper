/**
 * Public types for the round tripper.
 *
 * Naming note: the primary artifact dial is `coarseness` (0..1), NOT a raw quantizer.
 * The spike measured that at the same nominal QP, AV1 is ~2.5x more efficient than AVC
 * (815 vs 2084 bytes/frame) — i.e. it artifacts visibly LESS — and that AVC's QP range is
 * 0-51 while VP9/AV1 are 0-63. A single raw quantizer prop therefore cannot mean the same
 * thing across codecs. `coarseness` is mapped per codec in ./quantizer.ts so the dial keeps
 * its meaning when the codec changes underneath it. `rawQuantizer` is the escape hatch.
 */

/** A frame source. Implementations own their frames until handed over; the consumer closes them. */
export interface CaptureSource {
  /** Produce one frame. The caller takes ownership and MUST call .close() on it. */
  grab(timestamp: number): Promise<VideoFrame>
  /** Release anything retained (cached CSS, scratch canvases, observers). */
  dispose(): void
}

export type CodecFamily = 'avc' | 'vp9' | 'av1' | 'hevc'

export interface CodecChoice {
  codec: string
  family: CodecFamily
  hardwareAcceleration: HardwareAcceleration
  bitrateMode: 'quantizer' | 'constant' | 'variable'
}

export interface MoshConfig {
  /**
   * Drop every keyframe the encoder emits after this frame index, so subsequent deltas
   * apply to an increasingly stale reference. This is the classic datamosh bloom.
   * The decoder errors if its FIRST chunk is a delta, so frame 0's keyframe always passes
   * regardless of this value.
   */
  dropKeyframesAfter?: number
  /** Drop this fraction of delta chunks too (0..1). Adds tearing on top of the bloom. */
  dropDeltaChance?: number
  /** Deterministic seed for dropDeltaChance, so a look can be reproduced. */
  seed?: number
}

export interface RoundTripProps {
  children: React.ReactNode

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

  className?: string
  style?: React.CSSProperties
}
