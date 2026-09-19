import type { CodecChoice, CodecFamily } from '../types.ts'
import { familyOf } from '../quantizer.ts'
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

/**
 * Find the best supported (codec, acceleration, bitrateMode) triple.
 * Quantizer mode is strongly preferred — it is the primary artifact dial and its values are
 * codec-spec-defined, so a given QP means the same thing across encoders. Starved CBR is the
 * fallback only when no quantizer-capable config exists.
 */
export async function probeCodec(opts: ProbeOptions): Promise<CodecChoice | null> {
  const check: ConfigSupportFn =
    opts.isConfigSupported ??
    ((cfg) => VideoEncoder.isConfigSupported(cfg) as Promise<{ supported?: boolean }>)

  const codecs = candidatesFor(opts)
  const modes: Array<CodecChoice['bitrateMode']> = ['quantizer', 'constant', 'variable']

  for (const bitrateMode of modes) {
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
        if (ok) return { codec, family: familyOf(codec), hardwareAcceleration, bitrateMode }
      }
    }
  }
  return null
}
