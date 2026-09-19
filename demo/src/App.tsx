import { useMemo, useState } from 'react'
import { RoundTrip } from '@video-round-tripper/roundtrip'
import { Controls, DEFAULTS, moshFrom, type Knobs } from './Controls.tsx'
import { Page } from './content/Page.tsx'
import { DeviceInfo } from './DeviceInfo.tsx'

export function App() {
  const [k, setK] = useState<Knobs>(DEFAULTS)
  const set = (n: Partial<Knobs>) => setK((prev) => ({ ...prev, ...n }))

  /*
   * Memoized because moshFrom() builds a fresh object, and an unstable `mosh` identity makes
   * RoundTrip re-tune on every single render. The package now tolerates that, but there is no
   * reason to generate the churn: an unstable prop is the caller's bug to not create.
   */
  const mosh = useMemo(
    () => moshFrom(k),
    [k.mosh, k.dropKeyframesAfter, k.dropDeltaChance],
  )

  return (
    <div className="layout">
      <RoundTrip
        disabled={k.disabled}
        coarseness={k.coarseness}
        encodeScale={k.encodeScale}
        captureFps={k.captureFps}
        captureMode={k.captureMode}
        declaredFramerate={k.declaredFramerate}
        codec={k.codec}
        gop={k.gopInfinite ? 'infinite' : k.gop}
        mosh={mosh}
      >
        <Page />
      </RoundTrip>
      <div>
        <Controls k={k} set={set} />
        <DeviceInfo />
      </div>
    </div>
  )
}
