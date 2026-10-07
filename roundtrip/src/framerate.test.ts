import { describe, expect, it } from 'vitest'
import { createFramerateNotice, framerateApplies } from './framerate.ts'

describe('framerateApplies', () => {
  it('is false only for the quantizer mode', () => {
    expect(framerateApplies('quantizer')).toBe(false)
    expect(framerateApplies('constant')).toBe(true)
    expect(framerateApplies('variable')).toBe(true)
  })
})

describe('createFramerateNotice', () => {
  const avc = { codec: 'avc1.640028', bitrateMode: 'quantizer' as const }
  const av1 = { codec: 'av01.0.08M.08', bitrateMode: 'constant' as const }

  it('warns once on a quantizer-mode stream, however often it is asked', () => {
    const said: string[] = []
    const notice = createFramerateNotice((m) => said.push(m))
    notice(avc)
    notice(avc)
    notice({ ...avc, codec: 'hev1.1.6.L93.B0' })
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('declaredFramerate has no effect on avc1.640028')
    expect(said[0]).toContain('quantizer mode')
  })

  it('stays silent in the bitrate modes, where the setting is real', () => {
    const said: string[] = []
    const notice = createFramerateNotice((m) => said.push(m))
    notice(av1)
    notice({ ...av1, bitrateMode: 'variable' })
    expect(said).toHaveLength(0)
  })

  it('still warns for a later quantizer stream after constant ones passed silently', () => {
    const said: string[] = []
    const notice = createFramerateNotice((m) => said.push(m))
    notice(av1)
    notice(avc)
    expect(said).toHaveLength(1)
  })
})
