import { describe, expect, it } from 'vitest'
import { embedSize, WEBKIT_EMBED_BUDGET } from './replaceUnserializable.ts'

describe('embedSize', () => {
  it('never embeds more pixels than the box shows', () => {
    // A 540px clip in a 240px box: the SVG renders at CSS px, so the rest is thrown away.
    expect(embedSize(540, 540, 240, 240)).toEqual({ width: 240, height: 240 })
  })

  it('keeps the native size when the box is bigger', () => {
    expect(embedSize(540, 540, 960, 960)).toEqual({ width: 540, height: 540 })
  })

  it('covers the box on both axes when the aspects differ', () => {
    // object-fit cover / fill can need the larger of the two scales.
    expect(embedSize(1920, 1080, 480, 480)).toEqual({ width: 853, height: 480 })
  })

  it('holds a WebKit frame to 256x256 worth of pixels, keeping the aspect', () => {
    const square = embedSize(540, 540, 480, 480, WEBKIT_EMBED_BUDGET)
    expect(square).toEqual({ width: 256, height: 256 })
    const wide = embedSize(1920, 1080, 960, 540, WEBKIT_EMBED_BUDGET)
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 1)
    expect(wide.width * wide.height).toBeLessThanOrEqual(WEBKIT_EMBED_BUDGET + wide.width + wide.height)
  })

  it('leaves a frame already under the budget alone', () => {
    expect(embedSize(200, 200, 200, 200, WEBKIT_EMBED_BUDGET)).toEqual({ width: 200, height: 200 })
  })

  it('tolerates a zero box (not laid out) by ignoring the box cap', () => {
    expect(embedSize(540, 540, 0, 0)).toEqual({ width: 540, height: 540 })
  })
})
