import type { CodecChoice, CodecFamily } from '../types.ts'
import { familyOf, RATE_CONTROL } from '../quantizer.ts'
import { CODEC_PREFERENCE, codecStringsFor, isCodecFamily } from '../codecs.ts'

/**
 * Runtime codec selection.
 *
 * THE IMPORTANT PART: do NOT pin hardwareAcceleration:'prefer-hardware'. The issue recommends
 * it, and on the spike machine (Chrome 150 / macOS) it SILENTLY eliminates VP9 and AV1 —
 * isConfigSupported simply returns false with no indication why, because both are
 * software-only there. With 'no-preference' all of avc1/hev1/vp09/av01 are available.
 *
 * The pin buys nothing anyway: measured at 864x544 in quantizer mode, avc1 ran 4.1ms/frame,
 * vp09 4.2ms and av01 5.2ms. All three are comfortably realtime. So we sweep the acceleration
 * dimension rather than constrain it, and we sweep codec FAMILIES in artifact-interest order
 * (see codecs.ts) rather than in speed order — "fastest codec available" serves interactivity,
 * and interactivity is already satisfied by every option.
 *
 * Each family expands to several candidate strings because the level has to be derived from
 * the coded area. Getting that wrong is not a soft failure: `avc1.42001f` is refused outright
 * by the encoder past 921,600 px, which is why AVC never used to win on a laptop.
 */

export { CODEC_PREFERENCE }

const ACCEL: HardwareAcceleration[] = ['no-preference', 'prefer-hardware', 'prefer-software']

export type ConfigSupportFn = (
  cfg: VideoEncoderConfig,
) => Promise<{ supported?: boolean }>

export interface ProbeOptions {
  width: number
  height: number
  framerate: number
  /** A family name ('avc'), or a raw codec string to use verbatim. */
  codec?: string
  /** Family order to sweep. Defaults to CODEC_PREFERENCE. */
  codecPreference?: readonly CodecFamily[]
  bitrate?: number
  /** Injected for tests; defaults to the real VideoEncoder. */
  isConfigSupported?: ConfigSupportFn
}

/** Turn whatever the caller asked for into an ordered list of concrete codec strings. */
function candidatesFor(opts: ProbeOptions): string[] {
  const { width, height } = opts
  if (opts.codec) {
    // A family name expands; anything else is taken as a literal codec string, which is the
    // escape hatch for a profile/level combination this file does not know about.
    return isCodecFamily(opts.codec) ? codecStringsFor(opts.codec, width, height) : [opts.codec]
  }
  return (opts.codecPreference ?? CODEC_PREFERENCE).flatMap((f) =>
    codecStringsFor(f, width, height),
  )
}

/** A family's modes in order of preference: its RATE_CONTROL first, then the other two. */
export function modesFor(family: CodecFamily): Array<CodecChoice['bitrateMode']> {
  return RATE_CONTROL[family] === 'constant' ? ['constant', 'quantizer', 'variable'] : ['quantizer', 'constant', 'variable']
}

/**
 * Find the best supported (codec, acceleration, bitrateMode) triple.
 *
 * FAMILY FIRST, then each family's own mode order (#91). Every mode of a preferred family is
 * tried before any mode of the next one, so AVC-in-constant beats AV1-in-anything.
 *
 * This used to be the other way round — rank r meant "each family's r-th mode" — on the theory
 * that quantizer mode was the portable dial and worth more than the family. #72 took that
 * theory apart: AV1/VP9's quantizer cannot make them heavy, so their first choice is already a
 * starved constant bitrate, and "quantizer first" only ever meant "AVC/HEVC in quantizer". What
 * the rank order did in practice was hand the stage to AV1 whenever AVC had lost quantizer mode
 * — exactly the environment of a software-only AVC encoder (no VideoToolbox, e.g. headless
 * Chrome), which supports CBR but not per-frame QP. The family is what decides the look: AVC
 * is the one that moshes into the classic smear (see codecs.ts), AV1 gives a stutter at best,
 * and CODEC_PREFERENCE exists so the classic look wins whenever it is available in ANY mode.
 * The mode is a calibration detail by comparison; a constant-mode AVC still gets a working dial
 * because the pipeline turns coarseness into a bitrate for any constant-mode stream.
 *
 * Within a family, mode before profile/level string: every string is tried in the family's
 * first mode before any string in its second.
 */
export async function probeCodec(opts: ProbeOptions): Promise<CodecChoice | null> {
  const check: ConfigSupportFn =
    opts.isConfigSupported ??
    ((cfg) => VideoEncoder.isConfigSupported(cfg) as Promise<{ supported?: boolean }>)

  // Group the candidate strings by family, keeping their order. A raw codec string is a
  // family of one.
  const byFamily = new Map<CodecFamily, string[]>()
  for (const codec of candidatesFor(opts)) {
    const family = familyOf(codec)
    byFamily.set(family, [...(byFamily.get(family) ?? []), codec])
  }

  for (const [family, codecs] of byFamily) {
    for (const bitrateMode of modesFor(family)) {
      for (const codec of codecs) {
        for (const hardwareAcceleration of ACCEL) {
          const cfg: VideoEncoderConfig = {
            codec,
            width: opts.width,
            height: opts.height,
            framerate: opts.framerate,
            latencyMode: 'realtime',
            hardwareAcceleration,
            bitrateMode,
          }
          if (bitrateMode !== 'quantizer') cfg.bitrate = opts.bitrate ?? 200_000
          let ok = false
          try {
            ok = (await check(cfg)).supported === true
          } catch {
            ok = false
          }
          if (ok) return { codec, family, hardwareAcceleration, bitrateMode }
        }
      }
    }
  }
  return null
}
