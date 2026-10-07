import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPipeline } from './pipeline.ts'
import type { CodecChoice } from '../types.ts'

/*
 * WebCodecs does not exist under vitest, so these stand in for it and record what the pipeline
 * configures. They test the pipeline's own decisions — what it asks the encoder for — not any
 * codec's behaviour, which only a browser can answer.
 */
let configs: VideoEncoderConfig[] = []

class FakeEncoder {
  state = 'unconfigured'
  encodeQueueSize = 0
  configure(cfg: VideoEncoderConfig) {
    configs.push({ ...cfg })
    this.state = 'configured'
  }
  encode() {}
  close() {
    this.state = 'closed'
  }
}
class FakeDecoder {
  state = 'unconfigured'
  configure() {
    this.state = 'configured'
  }
  decode() {}
  close() {
    this.state = 'closed'
  }
}

const frame = () => ({ close() {} }) as unknown as VideoFrame
let now = 0

beforeEach(() => {
  configs = []
  now = 10_000
  vi.stubGlobal('VideoEncoder', FakeEncoder)
  vi.stubGlobal('VideoDecoder', FakeDecoder)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function build(choice: Pick<CodecChoice, 'codec' | 'family' | 'bitrateMode'>) {
  return createPipeline({
    ...choice,
    hardwareAcceleration: 'no-preference',
    width: 344,
    height: 360,
    declaredFramerate: 60,
    coarseness: 0.5,
    gop: 'infinite',
    mosh: false,
    onPicture: (f) => f.close(),
    onError: (e) => {
      throw e
    },
  })
}

describe('pipeline tune({ declaredFramerate }) (#70)', () => {
  it('reconfigures a constant-bitrate encoder with the new framerate on the next push', () => {
    const p = build({ codec: 'av01.0.04M.08', family: 'av1', bitrateMode: 'constant' })
    expect(configs.at(-1)!.framerate).toBe(60)
    p.tune({ declaredFramerate: 5 })
    p.push(frame())
    expect(configs).toHaveLength(2)
    expect(configs.at(-1)!.framerate).toBe(5)
    // and the bitrate the coarseness dial set is carried, not lost
    expect(configs.at(-1)!.bitrate).toBe(configs[0]!.bitrate)
  })

  it('applies under variable too, with a pinned bitrate', () => {
    const p = createPipeline({
      codec: 'avc1.640028', family: 'avc', bitrateMode: 'variable', hardwareAcceleration: 'no-preference',
      width: 344, height: 360, declaredFramerate: 60, bitrate: 200_000, coarseness: 0.5, gop: 'infinite',
      mosh: false, onPicture: (f) => f.close(), onError: (e) => { throw e },
    })
    p.tune({ declaredFramerate: 5 })
    p.push(frame())
    expect(configs.at(-1)).toMatchObject({ framerate: 5, bitrate: 200_000 })
  })

  it('never reconfigures a quantizer-mode encoder for it, since that would force a keyframe for nothing', () => {
    const p = build({ codec: 'avc1.640028', family: 'avc', bitrateMode: 'quantizer' })
    p.tune({ declaredFramerate: 5 })
    p.push(frame())
    p.push(frame())
    expect(configs).toHaveLength(1)
  })

  it('does not reconfigure when the value has not changed', () => {
    const p = build({ codec: 'av01.0.04M.08', family: 'av1', bitrateMode: 'constant' })
    p.tune({ declaredFramerate: 60 })
    p.push(frame())
    expect(configs).toHaveLength(1)
  })

  it('is rate-limited like the bitrate retarget, and lands once the window passes', () => {
    const p = build({ codec: 'av01.0.04M.08', family: 'av1', bitrateMode: 'constant' })
    p.tune({ declaredFramerate: 30 })
    p.push(frame())
    p.tune({ declaredFramerate: 5 })
    now += 100
    p.push(frame())
    expect(configs.at(-1)!.framerate).toBe(30)
    now += 200
    p.push(frame())
    expect(configs.at(-1)!.framerate).toBe(5)
  })
})
