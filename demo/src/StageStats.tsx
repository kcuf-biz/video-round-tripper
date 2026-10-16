import { useEffect, useState, type RefObject } from 'react'
import type { RoundTripHandle, RoundTripStats } from '@kcuf.biz/video-round-tripper'

/**
 * What the stage is doing, read off <RoundTrip>'s ref. Polled, because stats() is a snapshot
 * and paintFps decays to 0 on its own when painting stops — there is no event to wait for.
 * The handle outlives rebuilds, so the ref is read once per tick and never cached.
 */
export function StageStats({ stage }: { stage: RefObject<RoundTripHandle | null> }) {
  const [s, setS] = useState<RoundTripStats | null>(null)
  useEffect(() => {
    const tick = () => setS(stage.current?.stats() ?? null)
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [stage])

  if (!s) return null
  const size = (z: { width: number; height: number } | null) => (z ? `${z.width}x${z.height}` : '—')
  const lines = [
    `status: ${s.status} · build ${s.builds}`,
    `codec: ${s.codec ? `${s.codec.codec} · ${s.codec.bitrateMode}` : '—'}`,
    `content ${size(s.contentSize)} · encode ${size(s.encodeSize)}`,
    `painted ${s.painted} · ${s.paintFps.toFixed(1)} / s`,
    `encoded ${s.encoded} · decoded ${s.decoded} · dropped ${s.dropped}`,
    `moshed ${s.moshed} · decoder resets ${s.decoderResets}`,
  ]
  return (
    <aside className="panel" style={{ marginTop: 14 }}>
      <h2>Stage</h2>
      <pre className="device">{lines.join('\n')}</pre>
    </aside>
  )
}
