import { describe, expect, it } from 'vitest'
import { createStarvationGuard } from './starvation.ts'

/** Feed `n` inputs over one window, `out` of which come back, then evaluate. */
function windowOf(g: ReturnType<typeof createStarvationGuard>, t0: number, n: number, out: number, ms = 700) {
  for (let i = 0; i < n; i++) g.input(t0 + (i * ms) / n)
  for (let i = 0; i < out; i++) g.output()
  return g.check(t0 + ms)
}

describe('createStarvationGuard', () => {
  it('leaves an encoder that keeps up alone', () => {
    const g = createStarvationGuard()
    expect(windowOf(g, 0, 14, 14)).toBe(1)
    expect(windowOf(g, 700, 14, 8)).toBe(1) // over half came back
  })

  it('doubles the bitrate while frames are being skipped, and stops once they flow', () => {
    // VideoToolbox AVC at 50kbps: 2 of 60 frames out.
    const g = createStarvationGuard()
    expect(windowOf(g, 0, 14, 1)).toBe(2)
    expect(windowOf(g, 700, 14, 3)).toBe(4)
    expect(windowOf(g, 1400, 14, 14)).toBe(4)
    expect(windowOf(g, 2100, 14, 14)).toBe(4)
  })

  it('does not judge before a full window has passed', () => {
    const g = createStarvationGuard()
    g.input(0)
    expect(g.check(300)).toBe(1)
  })

  it('does not judge a window with too few inputs (idle on-interaction, hidden tab)', () => {
    const g = createStarvationGuard()
    expect(windowOf(g, 0, 3, 0)).toBe(1)
  })

  it('has a ceiling', () => {
    const g = createStarvationGuard({ maxBoost: 8 })
    for (let w = 0; w < 10; w++) windowOf(g, w * 700, 14, 0)
    expect(g.boost).toBe(8)
  })

  it('starts from a boost an earlier build learned', () => {
    expect(createStarvationGuard({ initialBoost: 8 }).boost).toBe(8)
    expect(createStarvationGuard({ initialBoost: 0 }).boost).toBe(1)
  })
})
