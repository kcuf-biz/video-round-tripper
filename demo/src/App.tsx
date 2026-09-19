import { useCallback, useMemo, useState } from 'react'
import { RoundTrip } from '@video-round-tripper/roundtrip'
import { Controls, DEFAULTS, moshFrom, type Knobs } from './Controls.tsx'
import { Page } from './content/Page.tsx'
import { DeviceInfo } from './DeviceInfo.tsx'
import { Overlay } from './Overlay.tsx'

export function App() {
  const [k, setK] = useState<Knobs>(DEFAULTS)
  const [uiOpen, setUiOpen] = useState(true)
  const set = (n: Partial<Knobs>) => setK((prev) => ({ ...prev, ...n }))
  const toggleUi = useCallback(() => setUiOpen((v) => !v), [])

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
    <>
      {/*
        Full-bleed: .stage gives the root a bounded height, which is what turns .rt-content
        into the scroll container. The content then scrolls UNDER a canvas that stays pinned
        to the viewport — and scrolling is the largest whole-frame motion the piece can
        produce, so it is where the encoder falls apart hardest.
      */}
      <RoundTrip
        className="stage"
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

      <Overlay open={uiOpen} onToggle={toggleUi}>
        <Controls k={k} set={set} />
        <DeviceInfo />
      </Overlay>
    </>
  )
}
