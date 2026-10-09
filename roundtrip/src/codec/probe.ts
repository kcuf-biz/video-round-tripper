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
  /**
   * Family first: AVC (then HEVC) in ANY mode before anything else, for when moshing is
   * wanted, since only they bloom. Off, the probe goes for the look first; see probeCodec.
   */
  preferMoshable?: boolean
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
 * TWO STRATEGIES (2026-10-09).
 *
 * LOOK FIRST, the default. Every family in its OWN best mode first, in preference order: AVC and
 * HEVC with a per-frame quantizer, VP9 and AV1 in a starved constant bitrate (#72). Only then
 * each family's other modes, family by family. So a device whose AVC has no quantizer mode
 * (every iPhone; Safari generally) gets VP9, not AVC in a bitrate mode. That is the order
 * before #91, and it is the right one for the look: hardware AVC in a bitrate mode does not get
 * uglier as the budget shrinks, it SKIPS FRAMES (VideoToolbox at a coarseness-starved ~50kbps:
 * one painted frame every 2-3s on the author's iPhone), while VP9 honours a starved rate with genuinely
 * bad frames and never stutters.
 *
 * FAMILY FIRST, with `preferMoshable` (and always when the caller names one family). Every mode
 * of a preferred family before any mode of the next, so AVC-in-a-bitrate-mode beats VP9 in
 * anything (#91): AVC and HEVC are the families whose moshing makes the classic smear, so a
 * caller that wants moshing takes them in whatever mode the device offers. The site turns this
 * on with Enable Mosh.
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

  // The (family, mode) pairs to try, in order. See the two strategies above.
  type Step = [CodecFamily, CodecChoice['bitrateMode']]
  const families = [...byFamily.keys()]
  const order: Step[] =
    opts.preferMoshable || opts.codec !== undefined
      ? families.flatMap((f) => modesFor(f).map((m): Step => [f, m]))
      : [
          ...families.map((f): Step => [f, modesFor(f)[0]!]),
          ...families.flatMap((f) => modesFor(f).slice(1).map((m): Step => [f, m])),
        ]

  for (const [family, bitrateMode] of order) {
    for (const codec of byFamily.get(family)!) {
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
  return null
}
