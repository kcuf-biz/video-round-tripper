import type { CodecFamily } from './types.ts'

/**
 * Per-codec quantizer ranges, from the codec specs (not from the WebCodecs spec — QP range
 * and meaning belong to each codec, which is exactly why quantizer mode is portable at all).
 */
const RANGE: Record<CodecFamily, readonly [number, number]> = {
  avc: [0, 51],
  hevc: [0, 51],
  vp9: [0, 63],
  av1: [0, 63],
}

/**
 * Where each codec starts to visibly fall apart. Biased from the spike: at the same nominal
 * QP, AV1 produced 815 bytes/frame against AVC's 2084 — ~2.5x more efficient, so it needs to
 * be pushed considerably harder before it artifacts comparably.
 *
 * CALIBRATED BY EYE against the demo page, not derived. Refine it by looking, not by algebra:
 * the acceptance test for this table is that a given `coarseness` looks about the same after
 * you switch codecs. One measurement per codec is not enough to fit a curve to.
 */
const FLOOR: Record<CodecFamily, number> = {
  avc: 18,
  // 10, down from 20: the author by eye on /compare/ (2026-09-27, Mac Chrome, mosh off), matching AVC
  // at the same coarseness. A lower floor means lower QPs, so at 20 HEVC read heavier than AVC
  // through the bottom of the dial; the top (q51 at 1.0) is unchanged.
  hevc: 10,
  vp9: 24,
  av1: 32,
}

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * WHICH DIAL `coarseness` DRIVES, per family: a quantizer, or a starved constant bitrate.
 *
 * AV1 and VP9 cannot be made heavy through the quantizer in Chrome (#72). Measured at 344x360,
 * 16 frames, mosh off, bytes/frame from q2 to q63 (the top of the WebCodecs range):
 *   avc   2730 -> 184        av1  3885 -> 1196        vp9  2978 -> 1324
 * so at their maximum quantizer AV1/VP9 still spend what AVC does around q18-20 and come back
 * nearly clean — no FLOOR value makes coarseness 0.78 look alike across families. Chrome's
 * quantizer mode clamps short of what the codecs themselves can do: the SAME encoders under a
 * constant bitrate go down to 258 (av1) / 299 (vp9) bytes/frame at 20kbps with every frame
 * emitted, which is AVC-at-0.78 territory. So for these two the dial is a bitrate.
 */
export const RATE_CONTROL: Record<CodecFamily, 'quantizer' | 'constant'> = {
  avc: 'quantizer',
  hevc: 'quantizer',
  av1: 'constant',
  vp9: 'constant',
}

/*
 * Bits per pixel per SECOND at the two ends of the dial, interpolated geometrically: bitrate
 * perception is logarithmic, and a linear ramp would spend the whole top half of the slider on
 * differences nobody can see. Calibrated at 344x360 / 20fps against AVC: 20kbps there
 * (0.16 bpp/s) matches AVC at coarseness 0.78 in bytes/frame, and 200kbps (1.6) is close to
 * clean. the author-by-eye pass on /compare/ is what these numbers answer to, like FLOOR above.
 */
const BPP_CLEAN = 3.0
const BPP_STARVED = 0.07

/**
 * The keyframe interval `coarseness` asks for on a 'constant' family, when the caller has not
 * set a GOP (#72).
 *
 * The bitrate alone stops mattering early. AV1/VP9 will not make a keyframe smaller than ~2.1KB
 * at 344x360 (identical at 8kbps and 20kbps), so at a keyframe every 3 frames and 20fps the
 * keys alone cost ~115kbps — more than bitrateFor() asks for anywhere above coarseness ~0.3,
 * and from there to 1.0 every setting looked the same (the author: "the pulsing doesn't respond to the
 * slider"). What damage there is comes from how OFTEN the frame is re-broken by a starved key,
 * and how fast the deltas can heal it between keys — so the dial drives both. Below 0.15, no
 * periodic keys at all: the page heals and stays clean. Geometric from a key every 60 frames
 * to every 2, for the same reason bitrateFor is.
 *
 * On trial: the author agreed to test this, not to keep it.
 */
export function gopFor(coarseness: number): number | 'infinite' {
  const c = clamp01(coarseness)
  if (c < 0.15) return 'infinite'
  return Math.max(2, Math.round(60 * Math.pow(2 / 60, (c - 0.15) / 0.85)))
}

/** The constant bitrate `coarseness` asks for on a family whose RATE_CONTROL is 'constant'. */
export function bitrateFor(coarseness: number, width: number, height: number): number {
  const bpp = BPP_CLEAN * Math.pow(BPP_STARVED / BPP_CLEAN, clamp01(coarseness))
  // Encoders reject absurdly low targets; below a few kbps nothing changes anyway (the
  // keyframe floor measured the same at 8kbps as at 20kbps).
  return Math.max(4_000, Math.round(bpp * width * height))
}

/**
 * Map the normalized 0..1 `coarseness` dial onto a concrete quantizer for one codec, so the
 * dial keeps its meaning when the codec changes underneath it.
 */
export function quantizerFor(family: CodecFamily, coarseness: number): number {
  const [, max] = RANGE[family]
  const floor = FLOOR[family]
  return Math.round(floor + (max - floor) * clamp01(coarseness))
}

/** Shape the per-frame quantizer into the codec-specific slot `VideoEncoder.encode()` expects. */
export function encodeOptionsFor(family: CodecFamily, quantizer: number): VideoEncoderEncodeOptions {
  const [min, max] = RANGE[family]
  const q = Math.max(min, Math.min(max, Math.round(quantizer)))
  switch (family) {
    case 'av1':
      return { av1: { quantizer: q } } as VideoEncoderEncodeOptions
    case 'vp9':
      return { vp9: { quantizer: q } } as VideoEncoderEncodeOptions
    case 'hevc':
      /*
       * HEVC HAS ITS OWN SLOT, and putting its quantizer in the `avc` one does not error —
       * it is silently ignored. Measured at 864x544, 14 frames, Chrome 150 / macOS:
       *   { avc: { quantizer } }   q20 and q45 both 7450 bytes/frame, and only 2 of 14
       *                            frames ever came back out of the encoder.
       *   { hevc: { quantizer } }  q20 2876 bytes/frame, q45 499, all 14 frames emitted.
       * So the dial did nothing at all on HEVC. That was harmless while HEVC was last in the
       * probe order and never won; it is not harmless now that it is second.
       */
      return { hevc: { quantizer: q } } as VideoEncoderEncodeOptions
    case 'avc':
      return { avc: { quantizer: q } } as VideoEncoderEncodeOptions
  }
}

/** Derive the codec family from a WebCodecs codec string. */
export function familyOf(codec: string): CodecFamily {
  if (codec.startsWith('av01')) return 'av1'
  if (codec.startsWith('vp09') || codec.startsWith('vp8')) return 'vp9'
  if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 'hevc'
  return 'avc'
}
