import { useCallback, useMemo, useState } from 'react'
import { RoundTrip, type CodecChoice, type CodecDials } from '@video-round-tripper/roundtrip'
import {
  Controls,
  DEFAULTS,
  knobsFromDials,
  moshFrom,
  touchesDials,
  type Knobs,
  type PickedCodec,
} from './Controls.tsx'
import { Page } from './content/Page.tsx'
import { DeviceInfo } from './DeviceInfo.tsx'
import { Overlay } from './Overlay.tsx'

export function App() {
  const [k, setK] = useState<Knobs>(DEFAULTS)
  const [uiOpen, setUiOpen] = useState(true)

  /*
   * What the stage resolved, straight from the pipeline. Stable identity for the callback so
   * it never enters <RoundTrip>'s rebuild path; the component holds it in a ref anyway, but
   * there is no reason to hand it churn.
   */
  const [reported, setReported] = useState<PickedCodec | null>(null)
  const onCodec = useCallback(
    (choice: CodecChoice, dials: CodecDials) => setReported({ choice, dials }),
    [],
  )
  // Nothing is running while round-tripping is off, so the last report is stale — say so by
  // not having one, which puts the panels back on their own probe.
  const picked = k.disabled ? null : reported

  /*
   * Touching a per-codec dial takes the panel off auto. The spread order matters: an explicit
   * `auto` in the patch (the checkbox, turning it back on) still wins over the clear.
   *
   * Leaving auto SEEDS from what auto actually resolved to, before the patch lands on top.
   * Otherwise the knobs snap to this panel's own DEFAULTS, and the first touch silently
   * changes three dials nobody aimed at — unchecking "never send another keyframe" on AVC
   * turned moshing off, which made the GOP it was about look like it did nothing.
   */
  const set = (n: Partial<Knobs>) =>
    setK((prev) => {
      const base = touchesDials(n) && prev.auto && picked ? knobsFromDials(prev, picked.dials) : prev
      return { ...base, ...(touchesDials(n) ? { auto: false } : null), ...n }
    })
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
        onCodec={onCodec}
      >
        <Page />
      </RoundTrip>

      <Overlay open={uiOpen} onToggle={toggleUi}>
        <Controls k={k} set={set} picked={picked} />
        <DeviceInfo
          codec={k.codec}
          encodeScale={k.encodeScale}
          requested={requested}
          picked={picked}
        />
      </Overlay>
    </>
  )
}
