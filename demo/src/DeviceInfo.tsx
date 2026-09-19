import { useEffect, useState } from 'react'
import { encodeSize, probeCodec } from '@video-round-tripper/roundtrip'

/**
 * What this device can actually do. Worth showing because the demo is usually opened over the
 * tailnet on a device nobody can inspect directly — a phone, or a headless box's stream. The
 * two things that decide whether the piece can run at all are both invisible otherwise:
 * whether the origin is a secure context (WebCodecs is gated on it) and which codec the
 * device actually admits to supporting.
 */
export function DeviceInfo() {
  const [info, setInfo] = useState<string[]>(['probing…'])

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
         */
        const enc = encodeSize(window.innerWidth, window.innerHeight, 1)
        const choice = await probeCodec({ ...enc, framerate: 60 })
        lines.push(
          choice
            ? `picked: ${choice.family} — ${choice.codec}\n  ${choice.hardwareAcceleration} · ${choice.bitrateMode}`
            : 'picked: nothing supported',
        )
      }
      lines.push(`dpr: ${window.devicePixelRatio} · ${window.innerWidth}x${window.innerHeight}`)
      if (alive) setInfo(lines)
    })()
    return () => {
      alive = false
    }
  }, [])

  return (
    <aside className="panel" style={{ marginTop: 14 }}>
      <h2>This device</h2>
      <pre className="device">{info.join('\n')}</pre>
    </aside>
  )
}
