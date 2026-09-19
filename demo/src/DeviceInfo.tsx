import { useEffect, useState } from 'react'
import { encodeSize, probeCodec, resolveDials, type CodecDials } from '@video-round-tripper/roundtrip'

/**
 * What this device can actually do. Worth showing because the demo is usually opened over the
 * tailnet on a device nobody can inspect directly — a phone, or a headless box's stream. The
 * two things that decide whether the piece can run at all are both invisible otherwise:
 * whether the origin is a secure context (WebCodecs is gated on it) and which codec the
 * device actually admits to supporting.
 *
 * It also resolves the dials, because with the panel on "auto" the values the encoder is
 * actually using appear NOWHERE ELSE: they come from the codec family the probe picked, which
 * is the one thing the controls cannot know.
 */
export function DeviceInfo({
  codec,
  encodeScale,
  requested,
}: {
  codec: string
  encodeScale: number
  requested: Partial<CodecDials>
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
      if (have) {
        /*
         * Probed at the REAL coded size, not at a nominal 640x480: the codec string's level is
         * derived from the coded area and Chrome's encoder enforces it for AVC, so a probe at
         * a small size happily reports a codec the actual stage would be refused.
         *
         * Through encodeSize(), though, not the raw viewport. Chrome's AVC encoder REFUSES AN
         * ODD DIMENSION outright while HEVC accepts it — measured here at 606x713: both avc1
         * strings false, hev1 true; at 606x714 all three true. The pipeline always encodes an
         * even size, so probing the raw viewport reports a codec the pipeline would never
         * have picked.
         *
         * This is still an ESTIMATE of what the stage picked, not a reading of it: the stage
         * is the viewport minus whatever chrome the page has, so a borderline level could in
         * principle resolve differently. It tracks the codec select and encodeScale so the two
         * agree about the family in every case that is not borderline.
         */
        const enc = encodeSize(window.innerWidth, window.innerHeight, encodeScale)
        const choice = await probeCodec({
          ...enc,
          framerate: 60,
          codec: codec === 'auto' ? undefined : codec,
        })
        if (choice) {
          lines.push(`picked: ${choice.family} — ${choice.codec}`)
          lines.push(`  ${choice.hardwareAcceleration} · ${choice.bitrateMode}`)
          // The whole point of the table: whatever the caller left undefined is filled in from
          // the family, and only here is the result visible.
          const d = resolveDials(choice.family, { coarseness, gop, mosh })
          const from = (v: unknown) => (v === undefined ? ' (family default)' : '')
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
  }, [codec, encodeScale, coarseness, gop, mosh])

  return (
    <aside className="panel" style={{ marginTop: 14 }}>
      <h2>This device</h2>
      <pre className="device">{info.join('\n')}</pre>
    </aside>
  )
}

function describeMosh(mosh: CodecDials['mosh']): string {
  if (!mosh) return 'off'
  const parts = [`drop keys after ${mosh.dropKeyframesAfter ?? 0}`]
  if (mosh.dropDeltaChance) parts.push(`${Math.round(mosh.dropDeltaChance * 100)}% deltas`)
  return parts.join(' · ')
}
