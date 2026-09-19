import { describe, expect, it } from 'vitest'
import { createPacer, encodeSize, isAwake, shouldDropForBackpressure } from './frameBudget.ts'

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
    const p = createPacer()
    expect(p.due(0, 10)).toBe(true) // 100ms
    p.mark(0)
    expect(p.due(50, 10)).toBe(false)
    expect(p.due(100, 10)).toBe(true)
  })

  it('REGRESSION: a changed fps takes effect on the very next call', () => {
    // The rate used to be baked in at construction, inside a long-lived capture loop, so
    // dragging captureFps did nothing until something else forced a full pipeline rebuild.
    const p = createPacer()
    p.mark(0)
    expect(p.due(50, 10)).toBe(false) // 100ms interval: not yet
    expect(p.due(50, 60)).toBe(true) // same instant, faster rate: due now
  })
})

describe('shouldDropForBackpressure', () => {
  it('drops at or above the threshold', () => {
    expect(shouldDropForBackpressure(0, 4)).toBe(false)
    expect(shouldDropForBackpressure(3, 4)).toBe(false)
    expect(shouldDropForBackpressure(4, 4)).toBe(true)
  })
})

describe('isAwake', () => {
  it('continuous mode is always awake, whatever the wake clock says', () => {
    expect(isAwake('continuous', 10_000, 0, 600)).toBe(true)
  })

  it('on-interaction stays awake for the wake window after the last interaction', () => {
    expect(isAwake('on-interaction', 1000, 1000, 600)).toBe(true)
    expect(isAwake('on-interaction', 1600, 1000, 600)).toBe(true) // inclusive edge
    expect(isAwake('on-interaction', 1601, 1000, 600)).toBe(false)
  })
})
