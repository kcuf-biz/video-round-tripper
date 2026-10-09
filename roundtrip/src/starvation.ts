/**
 * Starvation guard for the bitrate modes. Pure so it can be tested without a browser.
 *
 * WHY. A starved bitrate is the dial for AV1/VP9 (#72), and since #91 an encoder with no
 * quantizer mode gets AVC in constant mode with the same treatment. Software encoders answer a
 * tiny budget with ugly frames, which is the point. Apple's hardware AVC encoder (VideoToolbox,
 * so every iPhone and Chrome on a Mac without quantizer mode) answers it by SKIPPING frames
 * until it can afford one. Measured at 394x852, 20fps, 60 real page frames: 50kbps -> 2 frames
 * out, 150kbps -> 15, 400kbps -> 60, constant and variable alike; software AVC emitted all 60 at
 * every rate. On the author's iPhone that was one painted frame every 2-3 seconds. The bloom is gone too,
 * since there is nothing between the frames to smear.
 *
 * WHAT. Count frames handed to the encoder against chunks it returns, over a short window. When
 * it returns too few, multiply the bitrate up a step and look again after a full window at the
 * new rate, until frames flow or the ceiling is reached. No device table: whatever floor an
 * encoder has is found by asking it. An encoder that keeps up never trips this, and quantizer
 * mode never consults it.
 */

export interface StarvationGuard {
  /** A frame went into the encoder. */
  input(now: number): void
  /** A chunk came out. */
  output(): void
  /**
   * Evaluate the window ending at `now`. Returns the bitrate multiplier to use from here on;
   * it only ever goes up.
   */
  check(now: number): number
  readonly boost: number
}

export interface StarvationOptions {
  /** Length of one look, in ms. */
  windowMs?: number
  /** Below this fraction of inputs coming back out, the encoder counts as starving. */
  minRatio?: number
  /** Too few inputs in a window to judge (an idle on-interaction page, a hidden tab). */
  minInputs?: number
  /** Multiplier per step. */
  step?: number
  /** Ceiling on the total multiplier. */
  maxBoost?: number
  /** Where to start: a boost already learned for this encoder by an earlier build. */
  initialBoost?: number
}

export function createStarvationGuard(o: StarvationOptions = {}): StarvationGuard {
  const windowMs = o.windowMs ?? 700
  const minRatio = o.minRatio ?? 0.5
  const minInputs = o.minInputs ?? 6
  const step = o.step ?? 2
  const maxBoost = o.maxBoost ?? 32
  let boost = Math.min(maxBoost, Math.max(1, o.initialBoost ?? 1))
  let start = -1
  let inputs = 0
  let outputs = 0

  return {
    input(now) {
      if (start < 0) start = now
      inputs++
    },
    output() {
      if (start >= 0) outputs++
    },
    check(now) {
      if (start < 0 || now - start < windowMs) return boost
      if (inputs >= minInputs && outputs < inputs * minRatio && boost < maxBoost) {
        boost = Math.min(maxBoost, boost * step)
      }
      // A fresh window either way, so a raised rate is judged on its own frames only.
      start = -1
      inputs = 0
      outputs = 0
      return boost
    },
    get boost() {
      return boost
    },
  }
}
