import { describe, expect, it } from 'vitest'
import { contentSize, createPacer, createRateMeter, encodeSize, isAwake, shouldDropForBackpressure } from './frameBudget.ts'

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

describe('contentSize', () => {
  it('is the unrounded display size, so an odd height leaves the pad row outside it (#75)', () => {
    expect(encodeSize(1200, 841, 1)).toEqual({ width: 1200, height: 842 })
    expect(contentSize(1200, 841, 1)).toEqual({ width: 1200, height: 841 })
    expect(contentSize(401, 301, 1)).toEqual({ width: 401, height: 301 })
  })

  it('never exceeds the encode frame, even when rounding to even went DOWN', () => {
    for (const scale of [1, 0.9, 0.73, 0.5, 0.31, 0.1]) {
      for (const [w, h] of [[1381, 907], [841, 1200], [3, 3], [1, 1]] as const) {
        const enc = encodeSize(w, h, scale)
        const c = contentSize(w, h, scale)
        expect(c.width).toBeLessThanOrEqual(enc.width)
        expect(c.height).toBeLessThanOrEqual(enc.height)
        expect(enc.width - c.width).toBeLessThanOrEqual(1)
        expect(enc.height - c.height).toBeLessThanOrEqual(1)
      }
    }
  })

  it('equals the encode size when the display size is already even', () => {
    expect(contentSize(800, 600, 1)).toEqual(encodeSize(800, 600, 1))
    expect(contentSize(800, 600, 0.5)).toEqual({ width: 400, height: 300 })
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

describe('createRateMeter', () => {
  it('counts marks in the trailing window, per second', () => {
    const m = createRateMeter(1000)
    for (let t = 0; t < 1000; t += 50) m.mark(t) // 20 marks over one second
    expect(m.rate(999)).toBe(20)
  })

  it('falls to 0 on its own when the marks stop — the idle case stats() exists to show', () => {
    const m = createRateMeter(1000)
    for (let t = 0; t < 1000; t += 50) m.mark(t)
    expect(m.rate(1475)).toBe(10) // the first half (0..450) has aged out
    expect(m.rate(2000)).toBe(0)
  })

  it('scales to the window it was given', () => {
    const m = createRateMeter(500)
    for (let t = 0; t < 500; t += 50) m.mark(t)
    expect(m.rate(499)).toBe(20)
  })

  it('stays bounded when marked and never read', () => {
    const m = createRateMeter(1000, 8)
    for (let i = 0; i < 100; i++) m.mark(10)
    expect(m.rate(10)).toBe(8)
  })

  it('reset() empties it, for a rebuild', () => {
    const m = createRateMeter(1000)
    m.mark(0)
    m.reset()
    expect(m.rate(1)).toBe(0)
  })
})
