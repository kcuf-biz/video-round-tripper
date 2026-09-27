import { describe, expect, it } from 'vitest'
import { CODEC_DEFAULTS, CODEC_PREFERENCE, codecStringsFor, isCodecFamily, resolveDials } from './codecs.ts'

describe('CODEC_PREFERENCE', () => {
  it('leads with AVC, because it is the only family that moshes into the classic look', () => {
    expect([...CODEC_PREFERENCE]).toEqual(['avc', 'hevc', 'av1', 'vp9'])
  })
})

describe('codecStringsFor', () => {
  it('offers Baseline 3.1 at 864x544, which is inside its 921,600px cap', () => {
    const s = codecStringsFor('avc', 864, 544)
    expect(s[0]).toBe('avc1.64001f')
    expect(s).toContain('avc1.42001f')
  })

  it('DROPS level 3.1 at 1440x900, which is the bug that hid AVC on every laptop', () => {
    // 1,296,000 px against 3.1's 921,600 cap. Chrome's encoder refuses the string outright
    // (measured: isConfigSupported false), so offering it first wasted the family's turn.
    const s = codecStringsFor('avc', 1440, 900)
    expect(s.some((c) => c.endsWith('1f'))).toBe(false)
    expect(s[0]).toBe('avc1.640028') // High 4.0
  })

  it('tries High before Baseline at each level', () => {
    const s = codecStringsFor('avc', 1440, 900)
    expect(s.slice(0, 4)).toEqual(['avc1.640028', 'avc1.420028', 'avc1.640029', 'avc1.420029'])
  })

  it('keeps higher levels as fallbacks rather than offering only the smallest that fits', () => {
    // A device may refuse one specific level for its own reasons; the next one up is a better
    // answer than falling through to a whole different codec family.
    const s = codecStringsFor('avc', 864, 544)
    expect(s.length).toBe(14)
    expect(s.at(-1)).toBe('avc1.420034') // 5.2
  })

  it('climbs to level 5.x for 4K', () => {
    expect(codecStringsFor('avc', 3840, 2160)[0]).toBe('avc1.640032') // 8,294,400px -> 5.0
    expect(codecStringsFor('hevc', 3840, 2160)[0]).toBe('hev1.1.6.L150.B0')
  })

  it('derives the HEVC level too, even though this Chrome does not enforce it', () => {
    expect(codecStringsFor('hevc', 864, 544)[0]).toBe('hev1.1.6.L93.B0')
    // 1,296,000px is past L93's 983,040 cap. Chrome 150/macOS admits it anyway (measured),
    // but a browser that enforces the level would fail exactly the way AVC did.
    expect(codecStringsFor('hevc', 1440, 900)[0]).toBe('hev1.1.6.L120.B0')
  })

  it('passes AV1 and VP9 through unchanged — Chrome enforces neither level', () => {
    expect(codecStringsFor('av1', 3840, 2160)).toEqual(['av01.0.04M.08'])
    expect(codecStringsFor('vp9', 3840, 2160)).toEqual(['vp09.00.10.08'])
  })

  it('still produces a candidate for a degenerate size rather than an empty list', () => {
    expect(codecStringsFor('avc', 0, 0).length).toBeGreaterThan(0)
  })
})

describe('isCodecFamily', () => {
  it('separates family names from raw codec strings', () => {
    expect(isCodecFamily('avc')).toBe(true)
    expect(isCodecFamily('avc1.42001f')).toBe(false)
    expect(isCodecFamily('auto')).toBe(false)
  })
})

describe('resolveDials', () => {
  it('gives AVC the measured classic-bloom settings out of the box', () => {
    expect(resolveDials('avc', {})).toEqual(CODEC_DEFAULTS.avc)
    expect(resolveDials('avc', {}).gop).toBe(20)
  })

  it('does NOT mosh AV1 or VP9 by default, because it does not look like moshing there', () => {
    expect(resolveDials('av1', {}).mosh).toBe(false)
    expect(resolveDials('vp9', {}).mosh).toBe(false)
    // Finite since coarseness became a starved bitrate there (#72): the static page only
    // breaks on keyframes, and heals between them.
    expect(resolveDials('vp9', {}).gop).toBe(3)
    expect(resolveDials('av1', {}).gop).toBe(3)
  })

  it('lets an explicit value win over the family default', () => {
    expect(resolveDials('avc', { gop: 8 }).gop).toBe(8)
    expect(resolveDials('av1', { mosh: { dropDeltaChance: 0.1 } }).mosh).toEqual({
      dropDeltaChance: 0.1,
    })
  })

  it('treats 0, false and "infinite" as explicit answers, not as absence', () => {
    // The whole table is dead code if these fall through — which is why RoundTrip.tsx must
    // not apply its own destructuring defaults to coarseness/gop/mosh.
    expect(resolveDials('avc', { coarseness: 0 }).coarseness).toBe(0)
    expect(resolveDials('avc', { mosh: false }).mosh).toBe(false)
    expect(resolveDials('avc', { gop: 'infinite' }).gop).toBe('infinite')
  })

  it('fills only the undefined fields', () => {
    const r = resolveDials('av1', { coarseness: 0.2 })
    expect(r).toEqual({ coarseness: 0.2, gop: 3, mosh: false })
  })
})
