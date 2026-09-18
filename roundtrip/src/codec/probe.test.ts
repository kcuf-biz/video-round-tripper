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

describe('probeCodec', () => {
  it('does NOT pin prefer-hardware, which would silently lose VP9 and AV1', () => {
    // This is the whole point of the module. On the spike machine, pinning
    // hardwareAcceleration:'prefer-hardware' (as the issue suggested) makes
    // isConfigSupported return false for av01 and vp09 with no indication why.
    return probeCodec({ ...base, isConfigSupported: spikeMachine }).then((choice) => {
      expect(choice).not.toBeNull()
      expect(choice!.codec).toBe('av01.0.04M.08')
      expect(choice!.hardwareAcceleration).not.toBe('prefer-hardware')
    })
  })

  it('prefers quantizer mode, because it is the primary artifact dial', async () => {
    const choice = await probeCodec({ ...base, isConfigSupported: spikeMachine })
    expect(choice!.bitrateMode).toBe('quantizer')
  })

  it('falls back to a starved constant bitrate when quantizer mode is unavailable', async () => {
    const noQuantizer: ConfigSupportFn = async (cfg) => ({
      supported: cfg.bitrateMode !== 'quantizer' && cfg.codec.startsWith('avc1'),
    })
    const choice = await probeCodec({ ...base, isConfigSupported: noQuantizer })
    expect(choice).toEqual(
      expect.objectContaining({ codec: 'avc1.42001f', bitrateMode: 'constant', family: 'avc' }),
    )
  })

  it('honours an explicit codec request instead of sweeping', async () => {
    const choice = await probeCodec({
      ...base,
      codec: 'avc1.42001f',
      isConfigSupported: spikeMachine,
    })
    expect(choice!.codec).toBe('avc1.42001f')
  })

  it('returns null rather than throwing when nothing is supported', async () => {
    const choice = await probeCodec({ ...base, isConfigSupported: async () => ({ supported: false }) })
    expect(choice).toBeNull()
  })

  it('treats a throwing isConfigSupported as unsupported rather than propagating', async () => {
    const choice = await probeCodec({
      ...base,
      isConfigSupported: async (cfg) => {
        if (cfg.codec.startsWith('av01')) throw new TypeError('bad codec string')
        return { supported: cfg.codec.startsWith('vp09') }
      },
    })
    expect(choice!.codec).toBe('vp09.00.10.08')
  })
})
