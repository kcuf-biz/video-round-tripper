import { useState } from 'react'
import { Drift } from './Drift.tsx'
import './page.css'

/**
 * The page being round-tripped. Chosen as artifact bait — every block here exists to make a
 * specific codec failure legible:
 *   small webfont text       -> ringing / mosquito noise around glyph edges
 *   saturated red on cyan    -> chroma bleed (4:2:0 subsamples colour, not luma)
 *   smooth wide gradient     -> banding
 *   high-frequency image     -> macroblocking under motion
 *   live controls            -> interaction feedback arriving late and degraded
 */
export function Page() {
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  return (
    <article className="page">
      <h1>Round Tripper</h1>
      <p className="lede">
        A page that has been through a video codec and come back wrong.
      </p>

      <div className="cols">
        <p>
          Compression is a way of deciding what matters. The encoder is told how many bits it may
          spend, and then it spends them, and what it does not spend them on is what you watch
          dissolve. Turn the dial far enough and the decision becomes visible.
        </p>
        <p>
          Chroma is subsampled before luma is, so colour goes first. Saturated type against a
          saturated ground is the fastest way to see it: the letterforms stay legible while their
          colour smears out past their own edges.
        </p>
        <p>
          Motion is coded as displacement from what came before. Deny the decoder a keyframe and
          the error has nowhere to be corrected — it just accumulates, and the page slowly becomes
          a record of everything that has moved across it.
        </p>
      </div>

      <div className="band" />

      <Drift />

      <div className="split">
        <div className="swatches">
          {['#ff0033', '#00e5ff', '#ffd400', '#00ff66', '#ff00aa', '#0033ff'].map((c) => (
            <div key={c} className="swatch" style={{ background: c }}>
              <span>{c}</span>
            </div>
          ))}
        </div>

        {/* Live controls: proof that hit-testing passes through the canvas untouched. */}
        <form className="card" onSubmit={(e) => e.preventDefault()}>
          <b>Interaction survives</b>
          <p>
            These are real elements under an opaque canvas. Focus them, type, hover — then watch
            it reach you a few frames late.
          </p>
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="type here" />
          </label>
          <label className="inline">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            artifacts are the deliverable
          </label>
          <button type="submit">{name ? `ok, ${name}` : 'hover me'}</button>
        </form>
      </div>
    </article>
  )
}
