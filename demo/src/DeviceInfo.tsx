import { useEffect, useState } from 'react'
import { probeCodec } from '@video-round-tripper/roundtrip'

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
        const choice = await probeCodec({ width: 640, height: 480, framerate: 60 })
        lines.push(
          choice
            ? `picked: ${choice.codec}\n  ${choice.hardwareAcceleration} · ${choice.bitrateMode}`
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
