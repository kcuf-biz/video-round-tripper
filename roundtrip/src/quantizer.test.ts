import { describe, expect, it } from 'vitest'
import { bitrateFor, encodeOptionsFor, familyOf, quantizerFor } from './quantizer.ts'

describe('familyOf', () => {
  it('maps codec strings to families', () => {
    expect(familyOf('av01.0.04M.08')).toBe('av1')
    expect(familyOf('vp09.00.10.08')).toBe('vp9')
    expect(familyOf('hev1.1.6.L93.B0')).toBe('hevc')
    expect(familyOf('avc1.42001f')).toBe('avc')
  })
})

describe('quantizerFor', () => {
  it('respects each codec spec range: AVC tops out at 51, VP9/AV1 at 63', () => {
    expect(quantizerFor('avc', 1)).toBe(51)
    expect(quantizerFor('hevc', 1)).toBe(51)
    expect(quantizerFor('vp9', 1)).toBe(63)
    expect(quantizerFor('av1', 1)).toBe(63)
  })

  it('biases AV1 higher at the same dial position, because it artifacts less', () => {
    // Measured in the spike: 815 bytes/frame for AV1 against 2084 for AVC at comparable QP.
    // Normalizing for range, AV1 must sit proportionally higher in its own range.
    const avc = quantizerFor('avc', 0) / 51
    const av1 = quantizerFor('av1', 0) / 63
    expect(av1).toBeGreaterThan(avc)
  })

  it('is monotonic and clamps out-of-range input', () => {
    let prev = -1
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const q = quantizerFor('av1', c)
      expect(q).toBeGreaterThanOrEqual(prev)
      prev = q
    }
    expect(quantizerFor('avc', -5)).toBe(quantizerFor('avc', 0))
    expect(quantizerFor('avc', 99)).toBe(quantizerFor('avc', 1))
  })
})

describe('encodeOptionsFor', () => {
  it('puts the quantizer in the codec-specific slot encode() expects', () => {
    expect(encodeOptionsFor('av1', 40)).toEqual({ av1: { quantizer: 40 } })
    expect(encodeOptionsFor('vp9', 40)).toEqual({ vp9: { quantizer: 40 } })
    expect(encodeOptionsFor('avc', 40)).toEqual({ avc: { quantizer: 40 } })
    // HEVC gets its OWN slot. In the `avc` one Chrome ignores it silently — measured at
    // 864x544, q20 and q45 both produced 7450 bytes/frame and only 2 of 14 frames ever came
    // back out of the encoder, against 2876/499 and all 14 with `hevc`.
    expect(encodeOptionsFor('hevc', 40)).toEqual({ hevc: { quantizer: 40 } })
  })

  it('clamps to the codec range rather than passing an illegal value to the encoder', () => {
    expect(encodeOptionsFor('avc', 63)).toEqual({ avc: { quantizer: 51 } })
    expect(encodeOptionsFor('av1', -9)).toEqual({ av1: { quantizer: 0 } })
  })
})

describe('bitrateFor', () => {
  it('falls geometrically with coarseness and scales with area', () => {
    const a = bitrateFor(0, 344, 360), b = bitrateFor(0.5, 344, 360), c = bitrateFor(1, 344, 360)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
    // Geometric: the midpoint is the geometric mean of the ends, not the arithmetic one.
    expect(b).toBeCloseTo(Math.sqrt(a * c), -2)
    expect(bitrateFor(0.5, 688, 720)).toBeCloseTo(4 * b, -3)
  })

  it('lands on the calibration point: ~20kbps at 344x360 and coarseness 0.78', () => {
    expect(bitrateFor(0.78, 344, 360)).toBeGreaterThan(17_000)
    expect(bitrateFor(0.78, 344, 360)).toBeLessThan(23_000)
  })

  it('never asks for less than an encoder will accept', () => {
    expect(bitrateFor(1, 16, 16)).toBe(4_000)
  })
})
