/**
 * Public types for the round tripper.
 *
 * REACT-FREE, deliberately. `./core` is the framework-free entry and it re-exports from here,
 * so a `React.ReactNode` in this file makes @types/react a hard requirement for a consumer who
 * imports the core bundle and has no React at all — verified against the packed tarball, where
 * it surfaced as "Cannot find namespace 'React'" twice. RoundTripProps therefore lives in
 * RoundTrip.tsx, next to the component it describes.
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
