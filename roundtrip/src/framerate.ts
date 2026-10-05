import type { CodecChoice } from './types.ts'

/**
 * WHERE `declaredFramerate` MEANS ANYTHING (#70).
 *
 * The declared framerate is the rate controller's per-frame budget: bitrate / framerate. Under
 * a bitrate mode that is the whole point of the lie — declare 60 while feeding 5 and each frame
 * gets a twelfth of what it needs. Under the quantizer mode there is no budget to divide, so the
 * number goes nowhere. Measured at 864x544, 12 frames: AVC 2421 vs 2422 bytes/frame at 5 vs 60,
 * AV1 byte-identical; under 'variable' the same change is 16057 vs 2838.
 *
 * Quantizer mode is the default for avc/hevc (RATE_CONTROL), so for most streams this dial does
 * nothing, and it used to do nothing silently. The fix is to SAY so rather than to remove it:
 * av1/vp9 run under a constant bitrate and so does any device whose probe fell back to one, and
 * on those it is a real lever. Which mode a stream got is only known once the probe answers, so
 * this can only ever be a runtime notice, not a type error.
 */
export function framerateApplies(bitrateMode: CodecChoice['bitrateMode']): boolean {
  return bitrateMode !== 'quantizer'
}

/**
 * A warner that speaks at most once over its lifetime, and only for a quantizer-mode stream.
 *
 * Once per PAGE, not per controller: the React component rebuilds its controller whenever
 * declaredFramerate changes, so per-controller would repeat it for every step of a dragged
 * slider. `warn` is injectable for the tests; nothing else should pass it.
 */
export function createFramerateNotice(warn: (message: string) => void = (m) => console.warn(m)) {
  let spoken = false
  return (choice: Pick<CodecChoice, 'codec' | 'bitrateMode'>): void => {
    if (spoken || framerateApplies(choice.bitrateMode)) return
    spoken = true
    warn(
      `[roundtrip] declaredFramerate has no effect on ${choice.codec}: it runs in quantizer mode, ` +
        `where there is no per-frame bit budget for it to divide. It applies only to bitrate ` +
        `modes ('constant' / 'variable'), which av1/vp9 use by default.`,
    )
  }
}
