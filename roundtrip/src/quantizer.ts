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
  hevc: 20,
  vp9: 24,
  av1: 32,
}

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

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
