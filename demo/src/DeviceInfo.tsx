import { useEffect, useState } from 'react'
import { encodeSize, probeCodec, resolveDials, type CodecDials } from '@kcuf.biz/video-round-tripper'
import { describeMosh, type PickedCodec } from './Controls.tsx'

/**
 * What this device can actually do. Worth showing because the demo is often opened on a device
 * nobody can inspect directly — a phone, or a remote machine's screen. The
 * two things that decide whether the piece can run at all are both invisible otherwise:
 * whether the origin is a secure context (WebCodecs is gated on it) and which codec the
 * device actually admits to supporting.
 *
 * It also shows the dials, because with the panel on "auto" the values the encoder is
 * actually using appear NOWHERE ELSE: they come from the codec family the probe picked, which
 * is the one thing the controls cannot know.
 */
export function DeviceInfo({
  codec,
  encodeScale,
  requested,
  picked,
}: {
  codec: string
  encodeScale: number
  requested: Partial<CodecDials>
  /** What the stage reported through onCodec. Null only until the first pipeline builds. */
  picked: PickedCodec | null
}) {
  const [info, setInfo] = useState<string[]>(['probing…'])
  const { coarseness, gop, mosh } = requested

  useEffect(() => {
    let alive = true
    ;(async () => {
      const lines: string[] = []
      lines.push(`secure context: ${window.isSecureContext ? 'yes' : 'NO — WebCodecs is gated on this'}`)
      const have = typeof VideoEncoder !== 'undefined'
      lines.push(`VideoEncoder: ${have ? 'present' : 'MISSING'}`)
      // Marks the values nobody asked for, which are exactly the ones the family table filled
      // in. Same test the package makes: undefined is the only thing that falls back.
      const from = (v: unknown) => (v === undefined ? ' (family default)' : '')

      if (picked) {
        /*
         * THE STAGE'S OWN ANSWER, not an estimate. <RoundTrip> reports the codec its probe
         * chose and the dials it resolved (onCodec), from inside the running pipeline — at the
         * stage's real coded size, for the dials really in force. Nothing here can disagree
         * with what is being encoded, which is what the fallback below could only approximate.
         */
        lines.push(`picked: ${picked.choice.family} — ${picked.choice.codec}`)
        lines.push(`  ${picked.choice.hardwareAcceleration} · ${picked.choice.bitrateMode}`)
        lines.push(`dials:  coarseness ${picked.dials.coarseness}${from(coarseness)}`)
        lines.push(`        gop ${picked.dials.gop}${from(gop)}`)
        lines.push(`        mosh ${describeMosh(picked.dials.mosh)}${from(mosh)}`)
      } else if (have) {
        /*
         * FALLBACK ONLY, for the moment before the stage has reported — and for the case
         * where it never will, because round-tripping is switched off and there is no
         * pipeline to report. It is an ESTIMATE: this probes the VIEWPORT, while the stage is
         * the viewport minus whatever chrome the page has, so a borderline level could in
         * principle resolve differently here than there.
         *
         * Even as an estimate it probes at the REAL coded size, not a nominal 640x480: the
         * codec string's level is derived from the coded area and Chrome's encoder enforces it
         * for AVC, so a probe at a small size happily reports a codec the stage would be
         * refused. Through encodeSize(), too — Chrome's AVC encoder REFUSES AN ODD DIMENSION
         * outright while HEVC accepts it (measured at 606x713: both avc1 strings false, hev1
         * true; at 606x714 all three true), and the pipeline always encodes an even size.
         */
        const enc = encodeSize(window.innerWidth, window.innerHeight, encodeScale)
        const choice = await probeCodec({
          ...enc,
          framerate: 60,
          codec: codec === 'auto' ? undefined : codec,
        })
        if (choice) {
          lines.push(`picked: ${choice.family} — ${choice.codec} (estimate)`)
          lines.push(`  ${choice.hardwareAcceleration} · ${choice.bitrateMode}`)
          const d = resolveDials(choice.family, { coarseness, gop, mosh })
          lines.push(`dials:  coarseness ${d.coarseness}${from(coarseness)}`)
          lines.push(`        gop ${d.gop}${from(gop)}`)
          lines.push(`        mosh ${describeMosh(d.mosh)}${from(mosh)}`)
        } else {
          lines.push('picked: nothing supported')
        }
      }
      lines.push(`dpr: ${window.devicePixelRatio} · ${window.innerWidth}x${window.innerHeight}`)
      if (alive) setInfo(lines)
    })()
    return () => {
      alive = false
    }
  }, [codec, encodeScale, coarseness, gop, mosh, picked])

  return (
    <aside className="panel" style={{ marginTop: 14 }}>
      <h2>This device</h2>
      <pre className="device">{info.join('\n')}</pre>
    </aside>
  )
}
