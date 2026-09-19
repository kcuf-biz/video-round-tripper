import { describe, expect, it } from 'vitest'
import { createMoshFilter, sameMoshConfig } from './mosh.ts'

describe('createMoshFilter', () => {
  it('passes everything when disabled', () => {
    const f = createMoshFilter(false)
    expect(f.decide('key', 0)).toBe('pass')
    expect(f.decide('delta', 1)).toBe('pass')
  })

  it('NEVER lets a delta reach an unprimed decoder', () => {
    // A VideoDecoder errors if its first chunk is a delta. This is the invariant the whole
    // module exists to protect, so it is asserted first and hardest.
    const f = createMoshFilter({ dropKeyframesAfter: 0 })
    expect(f.decide('delta', 0)).toBe('drop')
    expect(f.decide('delta', 1)).toBe('drop')
    expect(f.decide('key', 2)).toBe('pass') // primes here
    expect(f.decide('delta', 3)).toBe('pass')
  })

  it('passes the priming keyframe even when told to drop keyframes from frame 0', () => {
    const f = createMoshFilter({ dropKeyframesAfter: 0 })
    expect(f.decide('key', 0)).toBe('pass')
    // ...and drops every later one, so deltas accumulate against a stale reference.
    expect(f.decide('key', 1)).toBe('drop')
    expect(f.decide('key', 99)).toBe('drop')
  })

  it('only drops keyframes after the configured index', () => {
    const f = createMoshFilter({ dropKeyframesAfter: 10 })
    f.decide('key', 0)
    expect(f.decide('key', 5)).toBe('pass')
    expect(f.decide('key', 10)).toBe('pass')
    expect(f.decide('key', 11)).toBe('drop')
  })

  it('is deterministic for a given seed, so a look is reproducible', () => {
    const run = () => {
      const f = createMoshFilter({ dropDeltaChance: 0.5, seed: 42 })
      f.decide('key', 0)
      return Array.from({ length: 40 }, (_, i) => f.decide('delta', i + 1)).join('')
    }
    expect(run()).toBe(run())
  })

  it('reset re-arms the priming requirement', () => {
    const f = createMoshFilter({ dropDeltaChance: 0 })
    f.decide('key', 0)
    expect(f.decide('delta', 1)).toBe('pass')
    f.reset()
    expect(f.decide('delta', 2)).toBe('drop')
  })
})

describe('priming across filter swaps (regression)', () => {
  it('a filter created as already-primed passes deltas immediately', () => {
    // THE BUG: every prop change swapped the filter, and a fresh filter starts unprimed, so it
    // dropped every chunk until a keyframe. Under gop:'infinite' there is never another one,
    // so the picture froze permanently and read as a crash. Priming belongs to the decoder.
    const f = createMoshFilter({ dropKeyframesAfter: 0 }, true)
    expect(f.decide('delta', 900)).toBe('pass')
  })

  it('exposes primed so the pipeline can carry it across a swap', () => {
    const f = createMoshFilter({ dropKeyframesAfter: 0 })
    expect(f.primed).toBe(false)
    expect(f.decide('key', 0)).toBe('pass')
    expect(f.primed).toBe(true)
    // hand that state to the replacement, as tune() does
    const next = createMoshFilter({ dropKeyframesAfter: 5 }, f.primed)
    expect(next.decide('delta', 1)).toBe('pass')
  })

  it('a disabled filter always reports primed, so turning mosh ON later does not stall', () => {
    expect(createMoshFilter(false).primed).toBe(true)
  })
})

describe('sameMoshConfig', () => {
  it('compares by value, so a re-rendering caller does not churn the filter', () => {
    const a = { dropKeyframesAfter: 0, dropDeltaChance: 0.2, seed: 1 }
    expect(sameMoshConfig(a, { ...a })).toBe(true)
    expect(sameMoshConfig(a, { ...a, seed: 2 })).toBe(false)
    expect(sameMoshConfig(false, false)).toBe(true)
    expect(sameMoshConfig(false, a)).toBe(false)
  })
})
