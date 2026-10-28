/**
 * Pacing and backpressure. Pure so it can be tested without a browser.
 *
 * Backpressure is not optional here: the rasterizer measured ~8ms/frame while a starved
 * encoder can stall, and an unbounded encode queue fed by a fast capture loop is an OOM.
 * The correct response to a full queue is to DROP the captured frame, not to queue it —
 * dropped frames widen the inter-frame delta, which makes the artifacts better, not worse.
 */

export interface Pacer {
  /**
   * Has enough time passed to capture again?
   *
   * `fps` is passed per call rather than captured at construction: the pacer lives inside a
   * long-lived capture loop, so baking the rate in at creation meant changing captureFps did
   * nothing at all until something else forced a full pipeline rebuild.
   */
  due(now: number, fps: number): boolean
  mark(now: number): void
}

export function createPacer(): Pacer {
  let last = -Infinity
  return {
    due: (now, fps) => now - last >= 1000 / Math.max(1, fps),
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

const clampScale = (scale: number) => (scale <= 0 || scale > 1 ? 1 : scale)

/** Encode dimensions for a display size, honouring encodeScale. Both must be even for 4:2:0. */
export function encodeSize(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  const s = clampScale(scale)
  const even = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2)
  return { width: even(width), height: even(height) }
}

/**
 * The part of the encode frame the content actually occupies: the display size at encodeScale,
 * NOT rounded to even, and never larger than the frame.
 *
 * The encoder needs even dimensions and the page does not have them, so an odd display size
 * leaves a pad row (or column) past the content. Backlog #75: the canvas used to take the full
 * encode size as its backing store and stretch it over the odd CSS box, so the pad landed on
 * the last CSS pixel as a dark 1px line — the page's ground, or black before that was carried
 * (a real page measured 1200x842 backing in an 841px box, last row [0,3,37]). Capture renders into
 * this rect and repeats its edge into the pad; the canvas takes this size and draws only this
 * rect, so the pad is encoded but never shown.
 */
export function contentSize(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  const s = clampScale(scale)
  const enc = encodeSize(width, height, scale)
  const fit = (n: number, max: number) => Math.min(max, Math.max(1, Math.round(n * s)))
  return { width: fit(width, enc.width), height: fit(height, enc.height) }
}

/**
 * Whether 'on-interaction' mode is currently awake.
 *
 * Pulled out as a pure function deliberately: the rAF loop that calls it cannot be verified in
 * a backgrounded tab (Chrome suspends requestAnimationFrame when visibilityState is 'hidden'),
 * so the decision logic is tested here instead and the untestable surface is kept to the
 * scheduling call itself.
 */
export const WAKE_MS = 600

export function isAwake(
  mode: 'continuous' | 'on-interaction',
  now: number,
  wokeAt: number,
  wakeMs = WAKE_MS,
): boolean {
  if (mode === 'continuous') return true
  return now - wokeAt <= wakeMs
}

/**
 * A measured event rate over a trailing window: how many times `mark()` was called in the last
 * `windowMs`, per second.
 *
 * For the PAINT rate in stats() (#79). It is measured rather than derived from captureFps because
 * the two differ exactly when it matters: backpressure drops frames, a moshing decoder holds
 * deltas while it waits for a recovery key, on-interaction mode stops capturing when idle, and a
 * hidden tab pauses the whole loop. The page used to get this by wrapping drawImage on the
 * overlay canvas. Read-time decay is the point of a trailing window: when marks stop, `rate()`
 * falls to 0 within one window without anyone having to tell it the loop went quiet.
 */
export interface RateMeter {
  mark(now: number): void
  rate(now: number): number
  reset(): void
}

export function createRateMeter(windowMs = 1000, cap = 512): RateMeter {
  let stamps: number[] = []
  const prune = (now: number) => {
    const cutoff = now - windowMs
    let i = 0
    while (i < stamps.length && stamps[i]! <= cutoff) i++
    if (i > 0) stamps = stamps.slice(i)
  }
  return {
    mark(now) {
      stamps.push(now)
      // Bounded whatever happens: a caller that marks and never reads must not grow this forever.
      if (stamps.length > cap) stamps = stamps.slice(stamps.length - cap)
    },
    rate(now) {
      prune(now)
      return (stamps.length * 1000) / windowMs
    },
    reset() {
      stamps = []
    },
  }
}
