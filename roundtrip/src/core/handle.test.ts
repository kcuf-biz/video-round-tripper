import { describe, expect, it } from 'vitest'
import { idleStats, type RoundTripController, type RoundTripStats } from './createRoundTrip.ts'
import { readHandle } from './handle.ts'

function fake(stats: Partial<RoundTripStats>, blockedImages = 0): RoundTripController {
  return {
    tune() {},
    dispose() {},
    stats: () => ({ ...idleStats(), ...stats }),
    report: () => ({ blockedImages }) as unknown as ReturnType<RoundTripController['report']>,
  }
}

describe('readHandle', () => {
  it('reads as idle, with no report, while there is no controller', () => {
    const h = readHandle(() => null)
    expect(h.stats()).toEqual(idleStats())
    expect(h.report()).toBeUndefined()
  })

  it('follows the CURRENT controller across rebuilds rather than the one it was made with', () => {
    let current: RoundTripController | null = fake({ status: 'running', builds: 1 }, 2)
    const h = readHandle(() => current)
    expect(h.stats().builds).toBe(1)
    expect(h.report()).toEqual({ blockedImages: 2 })

    current = null // between dispose() and the next build
    expect(h.stats().status).toBe('idle')
    expect(h.report()).toBeUndefined()

    current = fake({ status: 'running', builds: 1, painted: 7 }, 0)
    expect(h.stats().painted).toBe(7)
    expect(h.report()).toEqual({ blockedImages: 0 })
  })

  it('hands out a fresh idle object each time, so a caller mutating one cannot poison the next', () => {
    const h = readHandle(() => null)
    const a = h.stats()
    a.painted = 99
    expect(h.stats().painted).toBe(0)
  })
})
