import type { CodecChoice } from '../types.ts'
import { familyOf } from '../quantizer.ts'

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
 * dimension rather than constrain it, and we sweep codecs in artifact-interest order rather
 * than in speed order — "fastest codec available" serves interactivity, and interactivity is
 * already satisfied by every option.
 */

/** Ordered by how interesting the artifacts are, not by speed. All are fast enough. */
export const CODEC_PREFERENCE = [
  'av01.0.04M.08',
  'vp09.00.10.08',
  'avc1.42001f',
  'hev1.1.6.L93.B0',
] as const

const ACCEL: HardwareAcceleration[] = ['no-preference', 'prefer-hardware', 'prefer-software']

export type ConfigSupportFn = (
  cfg: VideoEncoderConfig,
) => Promise<{ supported?: boolean }>

export interface ProbeOptions {
  width: number
  height: number
  framerate: number
  /** Only consider this codec. */
  codec?: string
  bitrate?: number
  /** Injected for tests; defaults to the real VideoEncoder. */
  isConfigSupported?: ConfigSupportFn
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

  const codecs = opts.codec ? [opts.codec] : [...CODEC_PREFERENCE]
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
