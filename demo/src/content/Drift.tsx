import { useEffect, useRef } from 'react'

/**
 * The two ANIMATED specimens on the contact sheet.
 *
 * WHY THESE ARE STILL JS-DRIVEN, now that CSS keyframes would work too.
 *
 * They did not used to: capture serializes the DOM into an SVG <foreignObject> loaded through
 * `new Image()`, that document gets a FRESH animation timeline on every load, and capture
 * builds a new Image per frame — so a CSS animation rendered at t=0 forever. Since
 * capture/animations.ts these specimens would survive as CSS: it snapshots the computed value
 * of every animated property onto the clone and switches the animation off there.
 *
 * Kept as they are on purpose, for two reasons. First, driving inline styles from rAF is the
 * ONE form of motion that needs nothing from the capture seam — no getAnimations(), no
 * computed-style read, no interpolation the snapshot has to agree with — so this page keeps
 * working as the control when something in animations.ts is suspect. Second, the values here
 * are not keyframe interpolations at all: the ramp's two stops travel at different rates and
 * the word runs a Lissajous with incommensurate frequencies, which is a function of t rather
 * than a track between two stops, and expressing it in CSS would mean flattening it into
 * keyframes and losing exactly the never-repeating quality it exists for.
 *
 * The CSS path has its own specimens instead — demo/src/hostile.tsx, #css-anim and #css-field.
 *
 * Why animation earns its place on an artifact contact sheet at all: a static page produces
 * near-zero inter-frame delta, which is precisely the condition under which an encoder behaves
 * itself. Motion is what makes it fail — and direction changes are what defeat motion
 * prediction, so both specimens deliberately never travel in a straight line for long.
 */
export function Drift() {
  const ramp = useRef<HTMLDivElement>(null)
  const word = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let raf = 0
    const start = performance.now()

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const t = (performance.now() - start) / 1000

      if (ramp.current) {
        /*
         * Dark stop and light stop both cycle, at different rates, so the CHORD changes rather
         * than the whole ramp just rotating in place. The ~150deg offset keeps the two ends
         * near-complementary for most of the cycle: that is the widest chroma distance, which
         * is what makes 4:2:0 subsampling show itself. It also keeps the pairing off the
         * blue-violet default that every generated gradient lands on.
         */
        const dark = (t * 11) % 360
        const light = (dark + 150 + Math.sin(t * 0.37) * 38 + 360) % 360
        ramp.current.style.backgroundImage =
          `linear-gradient(97deg,` +
          ` hsl(${dark.toFixed(1)} 64% 13%) 0%,` +
          ` hsl(${light.toFixed(1)} 52% 87%) 100%)`
      }

      if (word.current) {
        /*
         * Lissajous with incommensurate frequencies: covers the area, reads as non-repeating,
         * and is always turning. Percent-based so it needs no measurement of the container.
         */
        const x = 50 + Math.sin(t * 0.63) * 34 + Math.sin(t * 0.211) * 6
        const y = 50 + Math.cos(t * 0.41) * 27
        const r = Math.sin(t * 0.17) * 4.5
        word.current.style.left = `${x.toFixed(2)}%`
        word.current.style.top = `${y.toFixed(2)}%`
        word.current.style.transform = `translate(-50%,-50%) rotate(${r.toFixed(2)}deg)`
      }
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <>
      <figure className="spec spec-ramp">
        <div className="ramp" ref={ramp} />
        <figcaption>banding · both stops drifting</figcaption>
      </figure>

      <figure className="spec spec-drift">
        <div className="field">
          {/*
            "now" rather than a word that names its own artifact. A word meaning the present
            moment, arriving late and smeared, is the piece's actual thesis enacted; "GHOST"
            would just be captioning the effect.
          */}
          <span className="word" ref={word}>
            now
          </span>
        </div>
        <figcaption>motion · smear, trails, macroblock history</figcaption>
      </figure>
    </>
  )
}
