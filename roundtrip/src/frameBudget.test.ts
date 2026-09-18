import { describe, expect, it } from 'vitest'
import { createPacer, encodeSize, shouldDropForBackpressure } from './frameBudget.ts'

describe('encodeSize', () => {
  it('always returns even dimensions (4:2:0 chroma subsampling requires it)', () => {
    for (const scale of [1, 0.9, 0.73, 0.5, 0.31, 0.1]) {
      const { width, height } = encodeSize(1381, 907, scale)
      expect(width % 2).toBe(0)
      expect(height % 2).toBe(0)
      expect(width).toBeGreaterThanOrEqual(2)
      expect(height).toBeGreaterThanOrEqual(2)
    }
  })

  it('treats an out-of-range scale as 1 rather than producing a zero-size encoder', () => {
    expect(encodeSize(800, 600, 0)).toEqual({ width: 800, height: 600 })
    expect(encodeSize(800, 600, 4)).toEqual({ width: 800, height: 600 })
  })
})

describe('createPacer', () => {
  it('gates on the interval and is due immediately on first call', () => {
    const p = createPacer(10) // 100ms
    expect(p.due(0)).toBe(true)
    p.mark(0)
    expect(p.due(50)).toBe(false)
    expect(p.due(100)).toBe(true)
  })
})

describe('shouldDropForBackpressure', () => {
  it('drops at or above the threshold', () => {
    expect(shouldDropForBackpressure(0, 4)).toBe(false)
    expect(shouldDropForBackpressure(3, 4)).toBe(false)
    expect(shouldDropForBackpressure(4, 4)).toBe(true)
  })
})
