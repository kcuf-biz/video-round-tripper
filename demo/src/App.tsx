import { useCallback, useMemo, useState } from 'react'
import { RoundTrip } from '@video-round-tripper/roundtrip'
import { Controls, DEFAULTS, moshFrom, touchesDials, type Knobs } from './Controls.tsx'
import { Page } from './content/Page.tsx'
import { DeviceInfo } from './DeviceInfo.tsx'
import { Overlay } from './Overlay.tsx'

export function App() {
  const [k, setK] = useState<Knobs>(DEFAULTS)
  const [uiOpen, setUiOpen] = useState(true)
  /*
   * Touching a per-codec dial takes the panel off auto. The spread order matters: an explicit
   * `auto` in the patch (the checkbox, turning it back on) still wins over the clear.
   */
  const set = (n: Partial<Knobs>) =>
    setK((prev) => ({ ...prev, ...(touchesDials(n) ? { auto: false } : null), ...n }))
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

  /*
   * UNDEFINED, not a value, while the panel is on auto — and that distinction is the entire
   * point. `undefined` is the only thing resolveDials() falls back on, so sending 0.78 here
   * "because that is the default anyway" would make the per-codec table dead code and pin
   * every family to the same dials. Passed as one object so DeviceInfo can resolve exactly
   * what the pipeline resolves.
   */
  const requested = useMemo(
    () =>
      k.auto
        ? {}
        : { coarseness: k.coarseness, gop: k.gopInfinite ? ('infinite' as const) : k.gop, mosh },
    [k.auto, k.coarseness, k.gopInfinite, k.gop, mosh],
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
        coarseness={requested.coarseness}
        encodeScale={k.encodeScale}
        captureFps={k.captureFps}
        captureMode={k.captureMode}
        declaredFramerate={k.declaredFramerate}
        codec={k.codec}
        gop={requested.gop}
        mosh={requested.mosh}
      >
        <Page />
      </RoundTrip>

      <Overlay open={uiOpen} onToggle={toggleUi}>
        <Controls k={k} set={set} />
        <DeviceInfo codec={k.codec} encodeScale={k.encodeScale} requested={requested} />
      </Overlay>
    </>
  )
}
