import type { CodecFamily, MoshConfig } from './types.ts'

/**
 * Codec families, the codec strings each one expands to, and the per-family starting dials.
 *
 * Pure and unit-tested. Everything here is table lookup and string building; the only thing
 * that talks to the device is probe.ts, which walks the strings this file produces.
 */

/**
 * Probe order: AVC first, always.
 *
 * Not because AVC is fastest (they all are: measured at 864x544, avc1 4.1ms/frame, vp09 4.2,
 * av01 5.2) but because it is the only family whose moshing produces the look the piece is
 * for. AV1 drops resolve as tile gibberish and VP9's mosh is a guaranteed no-op. HEVC behaves
 * like AVC and is the natural second choice.
 *
 * Deliberately NOT mosh-dependent. The codec is frozen at the encoder's configure() call, so
 * ordering by the mosh config would rebuild the pipeline — and force a keyframe, wiping the
 * accumulated error the piece is made of — every time the mosh toggle moved.
 */
export const CODEC_PREFERENCE: readonly CodecFamily[] = ['avc', 'hevc', 'av1', 'vp9']

const FAMILIES = new Set<string>(['avc', 'hevc', 'av1', 'vp9'])

export function isCodecFamily(s: string): s is CodecFamily {
  return FAMILIES.has(s)
}

/*
 * LEVEL IS DERIVED FROM THE CODED AREA, and this is not theoretical.
 *
 * Measured in Chrome 150 / macOS at 1440x900 (1,296,000 px), 2026-09-19, quantizer mode,
 * hardwareAcceleration unset:
 *
 *   VideoEncoder.isConfigSupported            VideoDecoder.isConfigSupported
 *   avc1.42001f  (Baseline 3.1)  FALSE        true
 *   avc1.640028  (High 4.0)      true         true
 *   avc1.42002a  (Baseline 4.2)  true         true
 *   hev1.1.6.L93.B0  (3.1)       true         true
 *   hev1.1.6.L123.B0 (4.1)       true         true
 *
 * So: Chrome's ENCODER enforces the AVC level and its DECODER does not. `avc1.42001f` — the
 * only AVC string this package used to try — silently vanishes from the probe on any viewport
 * past 921,600 px, which is every laptop. That is why AVC never won the probe before and why
 * the piece was effectively AV1-only on this machine.
 *
 * HEVC's level is NOT enforced here (L93 is admitted at 1,296,000 px, well past its 983,040
 * cap). The table below still derives it, for two reasons: it costs one candidate string, and
 * a machine or browser that DOES enforce it would otherwise fail exactly the way AVC did. Do
 * not "simplify" it away on the evidence of this one machine.
 *
 * AV1 and VP9 strings carry a level too and Chrome enforces neither (verified earlier:
 * av01.0.04M.08, nominally level 3.0, encoded 1440x900). They are returned unchanged.
 */

/** AVC level_idc -> max luma samples per frame (MaxFS * 256, from Annex A of H.264). */
const AVC_LEVELS: ReadonlyArray<readonly [level: number, maxLuma: number]> = [
  [0x1f, 921_600], // 3.1
  [0x28, 2_097_152], // 4.0
  [0x29, 2_097_152], // 4.1
  [0x2a, 2_228_224], // 4.2
  [0x32, 8_912_896], // 5.0
  [0x33, 8_912_896], // 5.1
  [0x34, 9_437_184], // 5.2
]

/** HEVC general_level_idc (30 * level) -> max luma samples per frame (Annex A of H.265). */
const HEVC_LEVELS: ReadonlyArray<readonly [idc: number, maxLuma: number]> = [
  [93, 983_040], // 3.1
  [120, 2_228_224], // 4.0
  [123, 2_228_224], // 4.1
  [150, 8_912_896], // 5.0
  [153, 8_912_896], // 5.1
  [180, 35_651_584], // 6.0
  [183, 35_651_584], // 6.1
]

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/**
 * Candidate codec strings for a family at a given coded size, best first.
 *
 * Every level at or above the one the area requires is emitted, not just the smallest that
 * fits: a device is free to refuse a specific level for its own reasons, and the next one up
 * is a strictly better answer than falling through to the next family.
 */
export function codecStringsFor(family: CodecFamily, width: number, height: number): string[] {
  const area = Math.max(0, Math.round(width)) * Math.max(0, Math.round(height))
  switch (family) {
    case 'avc':
      // High (profile_idc 0x64) before Baseline (0x42) at each level: High is both better
      // looking at a given QP and universally available in hardware.
      return AVC_LEVELS.filter(([, max]) => max >= area).flatMap(([lvl]) => [
        `avc1.6400${hex2(lvl)}`,
        `avc1.4200${hex2(lvl)}`,
      ])
    case 'hevc':
      return HEVC_LEVELS.filter(([, max]) => max >= area).map(([idc]) => `hev1.1.6.L${idc}.B0`)
    case 'av1':
      return ['av01.0.04M.08']
    case 'vp9':
      return ['vp09.00.10.08']
  }
}

/** The subset of the dials that has a per-codec default. */
export interface CodecDials {
  coarseness: number
  gop: number | 'infinite'
  mosh: MoshConfig | false
}

/**
 * Where each family should start, so a bare <RoundTrip> lands somewhere worth looking at on
 * whatever codec the device admits to supporting.
 *
 * AVC/HEVC get the measured "occasional bloom" row from the mosh table in CLAUDE.md (GOP 20,
 * drop every keyframe: 20/24 frames painted, one moshed, no decoder resets) — the classic
 * look, out of the box. AV1 and VP9 do not: AV1's mosh resolves as tile gibberish rather than
 * as displaced macroblocks, and VP9's is a guaranteed no-op under an infinite GOP, so for both
 * of them moshing is opt-in and the default is straight compression.
 *
 * keepEveryNthKeyframe is what gives AVC and HEVC the RHYTHM that AV1 and VP9 get for free
 * from decoder death. Their decoders survive a dropped keyframe indefinitely, so error only
 * accumulates and the pipeline's recovery keyframe — which is what snaps AV1 back to clean —
 * never fires; measured on AVC at coarseness 0.78, error against the source went 3.8 -> 18 at
 * the dropped key and climbed to 24 with no recovery at all. Letting every 3rd keyframe
 * through restores bloom -> collapse -> snap, which is the look, instead of a one-way decay.
 *
 * coarseness 0.78 across all four so the dial reads the same after a codec switch. (The plan
 * left VP9's unstated; matching the others is the least surprising answer.)
 */
export const CODEC_DEFAULTS: Record<CodecFamily, CodecDials> = {
  avc: { coarseness: 0.78, gop: 20, mosh: { dropKeyframesAfter: 0, keepEveryNthKeyframe: 3, seed: 1 } },
  hevc: { coarseness: 0.78, gop: 20, mosh: { dropKeyframesAfter: 0, keepEveryNthKeyframe: 3, seed: 1 } },
  av1: { coarseness: 0.78, gop: 'infinite', mosh: false },
  vp9: { coarseness: 0.78, gop: 'infinite', mosh: false },
}

/**
 * Fill in whatever the caller did not specify, from the family the probe actually picked.
 *
 * `undefined` is the ONLY thing that falls back. `0`, `false` and `'infinite'` are explicit
 * answers and win — which is why the React component must not apply its own destructuring
 * defaults to these three props: doing so makes every value look explicit and this table dead.
 * Resolution happens after the probe, because that is the first moment the family is known.
 */
export function resolveDials(family: CodecFamily, requested: Partial<CodecDials>): CodecDials {
  const d = CODEC_DEFAULTS[family]
  return {
    coarseness: requested.coarseness ?? d.coarseness,
    gop: requested.gop ?? d.gop,
    mosh: requested.mosh ?? d.mosh,
  }
}
