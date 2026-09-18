import type { MoshConfig } from './types.ts'

/**
 * The chunk filter that sits between encoder and decoder.
 *
 * Two distinct effects live here:
 *  - keyframe SUPPRESSION is upstream, in the encoder (never ask for a keyframe). The spike
 *    confirmed no codec forces a periodic IDR, so that works on its own.
 *  - true DATAMOSHING is this filter: let the encoder emit its keyframe, then drop that chunk
 *    so the decoder keeps applying motion vectors to an increasingly stale reference.
 *
 * Hard constraint: a VideoDecoder errors if its FIRST chunk is a delta. Frame 0's keyframe
 * always passes, whatever the config says. That invariant is the reason this is a pure
 * function over (chunk type, index) — it is unit-testable without a browser.
 */
export type MoshDecision = 'pass' | 'drop'

/** Deterministic PRNG so a given seed reproduces a given look exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MoshFilter {
  decide(type: 'key' | 'delta', index: number): MoshDecision
  reset(): void
}

export function createMoshFilter(cfg: MoshConfig | false): MoshFilter {
  if (!cfg) {
    return { decide: () => 'pass', reset: () => {} }
  }
  const { dropKeyframesAfter, dropDeltaChance = 0, seed = 1 } = cfg
  let rand = mulberry32(seed)
  let primed = false

  return {
    decide(type, index) {
      // The decoder must be primed with a keyframe before anything else reaches it.
      if (!primed) {
        if (type !== 'key') return 'drop'
        primed = true
        return 'pass'
      }
      if (type === 'key' && dropKeyframesAfter !== undefined && index > dropKeyframesAfter) {
        return 'drop'
      }
      if (type === 'delta' && dropDeltaChance > 0 && rand() < dropDeltaChance) {
        return 'drop'
      }
      return 'pass'
    },
    reset() {
      primed = false
      rand = mulberry32(seed)
    },
  }
}
