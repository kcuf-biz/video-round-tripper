/**
 * Pacing and backpressure. Pure so it can be tested without a browser.
 *
 * Backpressure is not optional here: the rasterizer measured ~8ms/frame while a starved
 * encoder can stall, and an unbounded encode queue fed by a fast capture loop is an OOM.
 * The correct response to a full queue is to DROP the captured frame, not to queue it —
 * dropped frames widen the inter-frame delta, which makes the artifacts better, not worse.
 */

export interface Pacer {
  /** Has enough time passed to capture again? */
  due(now: number): boolean
  mark(now: number): void
}

export function createPacer(fps: number): Pacer {
  const interval = 1000 / Math.max(1, fps)
  let last = -Infinity
  return {
    due: (now) => now - last >= interval,
    mark: (now) => {
      last = now
    },
  }
}

/** Drop rather than queue once the encoder is this far behind. */
export const MAX_ENCODE_QUEUE = 4

export function shouldDropForBackpressure(queueSize: number, max = MAX_ENCODE_QUEUE): boolean {
  return queueSize >= max
}

/** Encode dimensions for a display size, honouring encodeScale. Both must be even for 4:2:0. */
export function encodeSize(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  const s = scale <= 0 || scale > 1 ? 1 : scale
  const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2)
  return { width: even(width), height: even(height) }
}
