import { describe, expect, it } from 'vitest'
import { probeCodec, type ConfigSupportFn } from './probe.ts'

const base = { width: 864, height: 544, framerate: 60 }

/** Model of the spike machine: AVC/HEVC have hardware encoders; VP9/AV1 are software-only. */
const spikeMachine: ConfigSupportFn = async (cfg) => {
  const swOnly = cfg.codec.startsWith('vp09') || cfg.codec.startsWith('av01')
  const hwOnly = cfg.codec.startsWith('avc1') || cfg.codec.startsWith('hev1')
  if (cfg.codec.startsWith('vp8')) return { supported: false }
  if (swOnly) return { supported: cfg.hardwareAcceleration !== 'prefer-hardware' }
  if (hwOnly) return { supported: cfg.hardwareAcceleration !== 'prefer-software' }
  return { supported: false }
}

/** The same machine with its hardware AVC/HEVC encoders taken away. */
const softwareOnly: ConfigSupportFn = async (cfg) => {
  if (cfg.codec.startsWith('avc1') || cfg.codec.startsWith('hev1')) return { supported: false }
  return { supported: cfg.hardwareAcceleration !== 'prefer-hardware' }
}

describe('probeCodec', () => {
  it('leads with AVC, the only family that moshes into the classic look', () => {
    return probeCodec({ ...base, isConfigSupported: spikeMachine }).then((choice) => {
      expect(choice!.family).toBe('avc')
      expect(choice!.codec).toBe('avc1.64001f') // High 3.1: 864x544 is inside the cap
    })
  })

  it('does NOT pin prefer-hardware, which would silently lose VP9 and AV1', async () => {
    // This is the whole point of the module. On the spike machine, pinning
    // hardwareAcceleration:'prefer-hardware' (as the issue suggested) makes
    // isConfigSupported return false for av01 and vp09 with no indication why — so with AVC
    // and HEVC gone, a probe that pinned it would find nothing at all.
    const choice = await probeCodec({ ...base, isConfigSupported: softwareOnly })
    expect(choice!.codec).toBe('av01.0.04M.08')
    expect(choice!.hardwareAcceleration).not.toBe('prefer-hardware')
  })

  it('derives the AVC level from the coded size instead of always offering 3.1', async () => {
    // 1440x900 is 1,296,000px, past Baseline 3.1's 921,600 cap. Chrome's encoder refuses
    // avc1.42001f outright there (measured), which is why AVC never used to win on a laptop.
    const seen: string[] = []
    const choice = await probeCodec({
      width: 1440,
      height: 900,
      framerate: 60,
      isConfigSupported: async (cfg) => {
        seen.push(cfg.codec)
        return { supported: cfg.codec !== 'avc1.42001f' && cfg.codec.startsWith('avc1') }
      },
    })
    expect(seen).not.toContain('avc1.42001f')
    expect(choice!.codec).toBe('avc1.640028')
  })

  it('prefers quantizer mode, because it is the primary artifact dial', async () => {
    const choice = await probeCodec({ ...base, isConfigSupported: spikeMachine })
    expect(choice!.bitrateMode).toBe('quantizer')
  })

  it('falls back to a starved constant bitrate when quantizer mode is unavailable', async () => {
    const noQuantizer: ConfigSupportFn = async (cfg) => ({
      supported: cfg.bitrateMode !== 'quantizer' && cfg.codec === 'avc1.42001f',
    })
    const choice = await probeCodec({ ...base, isConfigSupported: noQuantizer })
    expect(choice).toEqual(
      expect.objectContaining({ codec: 'avc1.42001f', bitrateMode: 'constant', family: 'avc' }),
    )
  })

  it('takes AVC in constant mode over AV1 in any mode: family first, then mode (#91)', async () => {
    // A software-only AVC encoder (headless Chrome, no VideoToolbox) has CBR but no per-frame
    // QP. Ranking by mode first handed that machine to AV1, the family that cannot mosh.
    const seen: string[] = []
    const noAvcQuantizer: ConfigSupportFn = async (cfg) => {
      seen.push(`${cfg.codec}:${cfg.bitrateMode}`)
      if (cfg.codec.startsWith('avc1')) return { supported: cfg.bitrateMode === 'constant' }
      if (cfg.codec.startsWith('av01')) return { supported: cfg.bitrateMode !== 'variable' }
      return { supported: false }
    }
    const choice = await probeCodec({ ...base, isConfigSupported: noAvcQuantizer })
    expect(choice).toEqual(expect.objectContaining({ family: 'avc', bitrateMode: 'constant' }))
    // ...and it got there without asking about AV1 at all.
    expect(seen.some((s) => s.startsWith('av01'))).toBe(false)
  })

  it("keeps each family's own mode order inside the family sweep", async () => {
    // Every AVC string in quantizer mode before any AVC string in constant.
    const seen: string[] = []
    await probeCodec({
      ...base,
      isConfigSupported: async (cfg) => {
        if (cfg.codec.startsWith('avc1')) seen.push(cfg.bitrateMode!)
        return { supported: false }
      },
    })
    const firstConstant = seen.indexOf('constant')
    expect(firstConstant).toBeGreaterThan(0)
    expect(seen.slice(0, firstConstant).every((m) => m === 'quantizer')).toBe(true)
    expect(seen.lastIndexOf('quantizer')).toBeLessThan(firstConstant)
  })

  it('gives AV1 and VP9 a constant bitrate first, because their quantizer cannot get heavy (#72)', async () => {
    for (const codec of ['av1', 'vp9']) {
      const choice = await probeCodec({ ...base, codec, isConfigSupported: spikeMachine })
      expect(choice!.bitrateMode).toBe('constant')
    }
    // ...while AVC, preferred, still wins the default sweep in quantizer mode.
    const def = await probeCodec({ ...base, isConfigSupported: spikeMachine })
    expect(def).toEqual(expect.objectContaining({ family: 'avc', bitrateMode: 'quantizer' }))
  })

  it('falls back to quantizer for AV1 when constant is refused', async () => {
    const noCbr: ConfigSupportFn = async (cfg) => ({ supported: cfg.bitrateMode !== 'constant' && (await spikeMachine(cfg)).supported === true })
    const choice = await probeCodec({ ...base, codec: 'av1', isConfigSupported: noCbr })
    expect(choice!.bitrateMode).toBe('quantizer')
  })

  it('expands a family name in the codec option', async () => {
    const choice = await probeCodec({ ...base, codec: 'av1', isConfigSupported: spikeMachine })
    expect(choice!.codec).toBe('av01.0.04M.08')
  })

  it('honours a raw codec string verbatim instead of sweeping', async () => {
    const seen: string[] = []
    const choice = await probeCodec({
      ...base,
      codec: 'avc1.42001f',
      isConfigSupported: async (cfg) => {
        seen.push(cfg.codec)
        return spikeMachine(cfg)
      },
    })
    expect(choice!.codec).toBe('avc1.42001f')
    expect(new Set(seen)).toEqual(new Set(['avc1.42001f']))
  })

  it('sweeps families in the order given, not the default one', async () => {
    const choice = await probeCodec({
      ...base,
      codecPreference: ['vp9', 'avc'],
      isConfigSupported: spikeMachine,
    })
    expect(choice!.family).toBe('vp9')
  })

  it('returns null rather than throwing when nothing is supported', async () => {
    const choice = await probeCodec({ ...base, isConfigSupported: async () => ({ supported: false }) })
    expect(choice).toBeNull()
  })

  it('treats a throwing isConfigSupported as unsupported rather than propagating', async () => {
    const choice = await probeCodec({
      ...base,
      isConfigSupported: async (cfg) => {
        if (!cfg.codec.startsWith('vp09')) throw new TypeError('bad codec string')
        return { supported: true }
      },
    })
    expect(choice!.codec).toBe('vp09.00.10.08')
  })
})
