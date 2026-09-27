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

/**
 * What a capture had to give up on. Every count is a thing that cannot be round-tripped
 * faithfully and is standing in as a flat grey block or a fallback font — surfaced so the
 * degradation is visible, because on a page made of deliberate artifacts an accidental one is
 * otherwise indistinguishable.
 */
export interface CaptureReport {
  /** Images, canvases and videos replaced by a placeholder: CORS refused, or tainted. */
  blockedImages: number
  /** @font-face files that could not be inlined, so the text renders in a fallback. */
  missingFonts: number
  /** Custom elements that appear to hide a CLOSED shadow root. Heuristic; see shadowDom.ts. */
  closedShadowRoots: number
  /** <iframe>s, which render blank inside foreignObject and are always placeholdered. */
  iframes: number
  /**
   * `url(#id)` / `href="#id"` references (gradients, patterns, masks, filters, clip-paths,
   * <use>) whose target is outside the captured subtree. SVG paints a missing paint server as
   * `none`, so each one is an element that silently vanished from the frame.
   */
  brokenReferences: number
  /**
   * Background images on an ancestor of the captured element (other than html/body, which are
   * carried whole). Its colour is carried; the image would be positioned against a box the
   * clone does not have, so it is left out and counted here.
   */
  ancestorBackgroundImages: number
}

/** A frame source. Implementations own their frames until handed over; the consumer closes them. */
export interface CaptureSource {
  /** Produce one frame. The caller takes ownership and MUST call .close() on it. */
  grab(timestamp: number): Promise<VideoFrame>
  /** Release anything retained (cached CSS, scratch canvases, observers). */
  dispose(): void
  /**
   * What the most recent grab() could not reproduce.
   *
   * Optional twice over: not every source degrades, and a source that does has nothing to
   * report until it has actually captured something. `undefined` therefore means "no frame
   * yet", which is NOT the same answer as a report of zeroes, and a source must not fake the
   * second — a page with a blocked image reading `blockedImages: 0` is precisely the silent
   * degradation this interface exists to make visible.
   */
  report?(): CaptureReport | undefined
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
  /**
   * Let every Nth keyframe after `dropKeyframesAfter` through, so the bloom snaps back to
   * clean on a rhythm; with GOP 20 at 30 captured fps, 2 means a snap every ~1.3s.
   * undefined/0 = never (today's behaviour).
   */
  keepEveryNthKeyframe?: number
  /** Drop this fraction of delta chunks too (0..1). Adds tearing on top of the bloom. */
  dropDeltaChance?: number
  /** Deterministic seed for dropDeltaChance, so a look can be reproduced. */
  seed?: number
}
