import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { mountRoundTrip, type CaptureReport, type MountedRoundTrip, type RoundTripStats } from '@video-round-tripper/roundtrip'
import './index.css'
import './hostile.css'

/**
 * THE HOSTILE PAGE — one specimen per thing that silently degrades.
 *
 * The demo page is artifact bait: it was authored to make codec failures legible, and every
 * resource on it is same-origin, serializable and already handled. This page is the opposite.
 * Nothing here is chosen to look good; each block is the smallest thing that fails if one
 * piece of the capture seam is wrong, and fails VISIBLY rather than by throwing.
 *
 * Mounted with mountRoundTrip, NOT with <RoundTrip>. The React component is covered by the
 * main demo; this page is where the vanilla path — the one the IIFE uses on a page nobody
 * authored — gets exercised against the specimens that break capture.
 */

/* Verified 2026-09-19 with curl, Origin: http://127.0.0.1:5395 —
 *   upload.wikimedia.org  -> access-control-allow-origin: *      (inlines)
 *   www.gstatic.com       -> no ACAO header at all               (refused -> grey placeholder)
 * Wikimedia now rejects arbitrary thumbnail widths with a 400 ("use thumbnail sizes listed
 * on ..."); 120/250/330 are accepted, 500 was rate-limited. Hence 330px. */
const CORS_OK = 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/330px-Cat03.jpg'
const CORS_NO = 'https://www.gstatic.com/webp/gallery/1.jpg'

/* ------------------------------------------------------------------- custom elements */

const SHADOW_STYLE = `
  :host { display: block; background: #123b3f; padding: 10px; }
  :host(.warm) { background: #4a2718; }
  p { margin: 0 0 6px; color: #7ef0d0; font-size: 15px; }
  ::slotted(b) { color: #ffd400; font-size: 17px; }
`

class ShadowSpecimen extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = SHADOW_STYLE
    root.append(style)
    const p = document.createElement('p')
    p.textContent = 'shadow text'
    const slot = document.createElement('slot')
    root.append(p, slot)

    // The other route into a shadow root's styling, and a different code path: constructed
    // sheets are never <style> elements and never appear in the cloned tree at all.
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(':host { border-left: 6px solid #00e5ff } p { letter-spacing: .04em }')
    root.adoptedStyleSheets = [sheet]
  }
}

/** No open root and no children: what a closed root looks like from outside. */
class ClosedSpecimen extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'closed' })
    root.innerHTML = '<div style="background:#3a2f5c;padding:14px;color:#cfc3ff">closed root</div>'
  }
}

/**
 * #74: an animation that lives INSIDE an open shadow root — keyframes declared in the shadow
 * <style>, running on a shadow element. Wall-clock driven on purpose (no --seek), so the
 * custom-property pass cannot move it by accident: only freezeAnimations reaching into the
 * flattened shadow subtree can.
 */
class ShadowAnimSpecimen extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        :host { display: block; position: relative; height: 134px; background: #1d2c3a; overflow: hidden; }
        .bar { position: absolute; left: 12px; top: 52px; width: 60px; height: 30px;
               background: #ffd400; animation: slide 4s ease-in-out infinite alternate, hue 3s linear infinite; }
        @keyframes slide { to { transform: translateX(150px) rotate(90deg); } }
        @keyframes hue { 0% { background: #ffd400; } 50% { background: #00e5ff; } 100% { background: #ff0033; } }
      </style>
      <div class="bar"></div>`
  }
}

/**
 * #94: the #87 serialization hole, inside a shadow root. `background: var(--x)` then
 * `background-size` in one rule reads back from the CSSOM as `background-image: ;`, and shadow
 * CSS is rewritten rule by rule from the CSSOM. Three cells: the lossy rule at the top level of
 * a shadow <style>, the same inside @media, and the same in an adopted sheet. The first two
 * must show STRIPES (shadowDom.ts falls back to the <style>'s text per rule). The third is the
 * known gap -- a constructed sheet keeps no source text -- and is EXPECTED GREY in the video,
 * counted as `lost decls`.
 */
class ShadowBgVarSpecimen extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        :host { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; height: 150px; }
        :host > div { --s: repeating-linear-gradient(45deg, #ff0033 0 14px, #ffd400 14px 28px); }
        .top { background: var(--s); background-size: 80px 80px; }
        @media (min-width: 1px) {
          .media { background: var(--s); background-size: 80px 80px; }
        }
      </style>
      <div class="top"></div><div class="media"></div><div class="adopted"></div>`
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(
      '.adopted { --a: repeating-linear-gradient(45deg, #00e5ff 0 14px, #2d6cdf 14px 28px);' +
        ' background: var(--a); background-size: 80px 80px; }',
    )
    root.adoptedStyleSheets = [sheet]
  }
}

if (!customElements.get('shadow-specimen')) customElements.define('shadow-specimen', ShadowSpecimen)
if (!customElements.get('shadow-anim-specimen')) customElements.define('shadow-anim-specimen', ShadowAnimSpecimen)
if (!customElements.get('shadow-bgvar-specimen')) customElements.define('shadow-bgvar-specimen', ShadowBgVarSpecimen)
if (!customElements.get('closed-specimen')) customElements.define('closed-specimen', ClosedSpecimen)

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /*
       * `class`, not `className`. React 18 does not treat a custom element as a host
       * component, so className is written through as the attribute value it stringifies to
       * -- which for an absent class is the literal string "null". Caught by :host(.warm)
       * silently not matching.
       */
      'shadow-specimen': { class?: string; children?: React.ReactNode }
      'closed-specimen': { class?: string }
      'shadow-anim-specimen': Record<string, never>
      'shadow-bgvar-specimen': Record<string, never>
    }
  }
}

/* --------------------------------------------------------------------------- specimens */

function Figure({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <figure data-spec={id}>
      {children}
      <figcaption>{label}</figcaption>
    </figure>
  )
}

/**
 * Drawn from JS, never from CSS or a bare rAF: a canvas is only ever as current as the last
 * time something drew into it, and nothing in the capture path can draw into it for you.
 * (CSS keyframes elsewhere on this page DO survive now — capture/animations.ts snapshots
 * their computed values — but a canvas is pixels, not computed style.)
 */
function CanvasSpec() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = 260
    c.height = 150
    const g = c.getContext('2d')!
    const grad = g.createLinearGradient(0, 0, 260, 150)
    grad.addColorStop(0, '#ff0033')
    grad.addColorStop(1, '#00e5ff')
    g.fillStyle = grad
    g.fillRect(0, 0, 260, 150)
    g.fillStyle = '#fff'
    g.font = 'bold 34px ui-monospace, monospace'
    g.fillText('canvas', 16, 90)
  }, [])
  return <canvas className="box" ref={ref} />
}

/**
 * The realistic case: a video file.
 *
 * MEASURED, and it is a trap. In a BACKGROUNDED tab this file takes many seconds to reach
 * readyState 1 -- for the first several seconds after load it sits at readyState 0 with
 * networkState NETWORK_LOADING and videoWidth 0, even though the file is served fine (200,
 * video/mp4, 5998B). Capture during that window correctly emits a placeholder, which looks
 * exactly like a CORS refusal. And once it does decode it stays paused at currentTime 0
 * forever, so it captures as a freeze-frame rather than as motion.
 *
 * Neither is capture failing; both are the hidden tab. Same family as the rAF gotcha.
 * VideoStreamSpec below exists so the branch can be proven without waiting on any of it.
 */
function VideoFileSpec() {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    v.load()
    v.play().catch(() => {})
  }, [])
  return (
    <video className="box" ref={ref} src="/specimen.mp4" preload="auto" loop muted playsInline autoPlay />
  )
}

/**
 * The same capture path, driven by a canvas-captured MediaStream instead of a file.
 *
 * A stream has no demuxer and no network fetch behind it, so it reaches readyState 4 with
 * real dimensions even in a hidden tab (verified: rs=4, 200x120). That makes it the only way
 * to actually exercise drawImage(video) -> scratch canvas -> toDataURL on this headless box.
 */
function VideoStreamSpec() {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const c = document.createElement('canvas')
    c.width = 260
    c.height = 150
    const g = c.getContext('2d')!
    g.fillStyle = '#0f6b75'
    g.fillRect(0, 0, 260, 150)
    g.fillStyle = '#ffd400'
    g.fillRect(24, 34, 120, 80)
    g.fillStyle = '#fff'
    g.font = 'bold 26px ui-monospace, monospace'
    g.fillText('stream', 20, 140)
    const stream = c.captureStream(5)
    v.srcObject = stream
    v.play().catch(() => {})
    return () => {
      for (const t of stream.getTracks()) t.stop()
    }
  }, [])
  return <video className="box" ref={ref} muted playsInline autoPlay />
}

/**
 * #74: a CSS TRANSITION, not a keyframe animation. A class flips every 5s and the box takes 4s
 * to get there, so most of the time it is mid-flight. The clone has the class but no running
 * transition of its own, so without freezeAnimations it would render the END state at once:
 * the video would show the box jumping between corners while the live one glides.
 */
function TransitionSpec() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const id = window.setInterval(() => setOn((v) => !v), 5000)
    const first = window.setTimeout(() => setOn(true), 300)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(first)
    }
  }, [])
  return (
    <div className="box spec-trans-box">
      <span className={on ? 'spec-trans on' : 'spec-trans'} />
    </div>
  )
}

/**
 * #74: the documented SKIP. A ::before keyframe animation has no element to pin an inline
 * value to, so capture leaves it alone and the clone's own timeline restarts it at t=0 every
 * frame: it should look FROZEN in the video while it moves live. Also creates an Animation with
 * a null effect (the non-KeyframeEffect skip), which must not break the index.
 */
function PseudoSpec() {
  useEffect(() => {
    const a = new Animation(null, document.timeline)
    a.play()
    return () => a.cancel()
  }, [])
  return <div className="box spec-pseudo" />
}

function Specimens() {
  return (
    <div className="hostile">
      <div className="bar">
        <span>STICKY HEADER</span>
        <span>holds at y=0 while the page scrolls under it</span>
      </div>

      <div className="grid">
        <Figure id="cors-ok" label="cross-origin img, ACAO: * — must inline">
          <img className="box" src={CORS_OK} alt="" />
        </Figure>

        <Figure id="cors-no" label="cross-origin img, no ACAO — must be a grey placeholder">
          <img className="box" src={CORS_NO} alt="" />
        </Figure>

        <Figure id="same-origin" label="same-origin img, relative src">
          <img className="box" src="../tile.png" alt="" />
        </Figure>

        <Figure id="font" label="self-hosted @font-face, relative url in a /public sheet">
          <div className="box spec-font" style={{ padding: 8, height: 134 }}>
            <b>Hamburgefonstiv</b>
          </div>
        </Figure>

        <Figure id="bg-rel" label="background-image, relative url in a /public sheet">
          <div className="spec-bg-rel" />
        </Figure>

        <Figure id="bg-cors" label="background-image, cross-origin ACAO: *">
          <div className="box" style={{ backgroundImage: `url(${CORS_OK})`, backgroundSize: 'cover' }} />
        </Figure>

        <Figure id="canvas" label="drawn canvas — toDataURL, not markup">
          <CanvasSpec />
        </Figure>

        <Figure id="video" label="video file — current frame via a scratch canvas">
          <VideoFileSpec />
        </Figure>

        <Figure id="video-stream" label="video from a canvas stream — decodes even when hidden">
          <VideoStreamSpec />
        </Figure>

        <Figure id="shadow" label="open shadow root: slot, :host, adoptedStyleSheets">
          <shadow-specimen class="warm">
            <b>slotted</b>
          </shadow-specimen>
        </Figure>

        <Figure id="closed" label="closed shadow root — counted, cannot be captured">
          <closed-specimen />
        </Figure>

        <Figure id="iframe" label="iframe — always a placeholder">
          <iframe
            className="box"
            title="iframe specimen"
            srcDoc="<body style='background:#6b2d8f;color:#fff;font:14px monospace'>iframe body</body>"
          />
        </Figure>

        {/*
          The two CSS-MOTION specimens. Both are driven by `--seek` on <html>, outside the
          captured subtree — see hostile.css for why that is the specimen rather than a
          shortcut. Without capture/animations.ts both of these serialize at their first
          keyframe: the word sits at translateX(0) in gold and the gradient renders at the
          @property initial values, in both cases identically no matter what --seek says.
        */}
        <Figure id="css-anim" label="CSS keyframes on transform + color — pinned inline">
          <div className="box spec-anim-box">
            <span className="spec-anim">swing</span>
          </div>
        </Figure>

        <Figure id="css-field" label=":root-animated @property gradient, read through var(--field)">
          <div className="box spec-field" />
        </Figure>

        {/* #86, #87 — see the end of hostile.css for what each one used to capture as. */}
        <Figure id="vw" label="15vw bar, cyan above a 1000px breakpoint — same in video at ?scale=0.5">
          <div className="box spec-vw">
            <span className="vw" />
          </div>
        </Figure>

        <Figure id="css-prop" label="@property angle animated inside the capture — cone must turn">
          <div className="box spec-prop" />
        </Figure>

        <Figure id="bg-var" label="background: var() then a longhand — stripes, not grey">
          <div className="spec-bgvar" />
        </Figure>

        <Figure id="shadow-bg-var" label="same, in a shadow root: <style> top, <style> @media — stripes; adopted — known skip, EXPECTED GREY, counted">
          <shadow-bgvar-specimen />
        </Figure>

        {/*
          #62: every one of these, alone, used to lose the WHOLE frame ("The source image
          cannot be decoded.") — a comment with a double hyphen, Alpine's @click and :class,
          an htmx-style prefixed name. innerHTML because React will not emit any of them.
        */}
        <Figure id="xml" label="comment with --, @click, :class, x-on:click — frame must survive">
          <div
            className="box"
            style={{ padding: 8, height: 134, boxSizing: 'border-box' }}
            dangerouslySetInnerHTML={{
              __html:
                '<!-- ---- section ---- --><p @click="go()" :class="{ on: open }" x-on:click="x">' +
                'still here</p><!-- -- -->',
            }}
          />
        </Figure>

        {/* #63: a gradient fill reached through CSS, through a style attribute, and one whose
            target is deliberately outside the capture (must vanish, and be counted). */}
        <Figure id="fragment" label="url(#grad) via CSS / style attr / missing target — 2 bars, 1 counted">
          <svg className="box" viewBox="0 0 260 150" preserveAspectRatio="none">
            <defs>
              <linearGradient id="spec-grad" x1="0" x2="1">
                <stop offset="0" stopColor="#ff0033" />
                <stop offset="1" stopColor="#00e5ff" />
              </linearGradient>
            </defs>
            <rect className="spec-frag-css" x="10" y="14" width="240" height="34" />
            <rect style={{ fill: 'url(#spec-grad)' }} x="10" y="58" width="240" height="34" />
            <rect className="spec-frag-missing" x="10" y="102" width="240" height="34" />
          </svg>
        </Figure>

        <Figure id="inherit" label="type inherited from outside the capture; line-height as a factor; 5rem at html 20px">
          <div className="box spec-inherit">
            inherited colour + face
            <p className="big">big line</p>
            <span className="rem" />
          </div>
        </Figure>

        <Figure id="states" label=":hover / :active / :focus / :focus-within — must reach the frame">
          <div className="box spec-states">
            <button type="button">hover or press me</button>
            <input defaultValue="focus me" />
          </div>
        </Figure>

        <Figure id="transition" label="CSS transition, 4s, flips every 5s — must GLIDE, not jump">
          <TransitionSpec />
        </Figure>

        <Figure id="shadow-anim" label="keyframes inside an open shadow root — must move">
          <shadow-anim-specimen />
        </Figure>

        <Figure id="pseudo-anim" label="::before animation — known skip, EXPECTED FROZEN in video">
          <PseudoSpec />
        </Figure>

        <Figure id="form" label="live form state — projected as attributes">
          <div className="box" style={{ padding: 8, height: 134 }}>
            <input defaultValue="typed" style={{ width: '90%' }} />
          </div>
        </Figure>
      </div>

      <div className="tall">
        <p>
          Below the fold, so the page is worth scrolling: the sticky bar above must stay at the
          top of the frame, and the spacer it leaves behind must keep this text from jumping.
        </p>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------------- degradation report */

/**
 * OUTSIDE .rt-content, like every other control on every page here: anything inside that
 * subtree is captured and round-tripped, so a panel reporting on the artifacts would be
 * encoded into them.
 *
 * It reads the RUNNING controller's report rather than taking its own throwaway capture. The
 * two are not interchangeable: a separate grab builds a separate resource cache, refetches
 * every font and image, and reports on a clone the pipeline never saw. What the panel has to
 * answer is "what did the frame you are looking at lose", and only the controller's own source
 * knows that.
 *
 * `undefined` is a real answer and is shown as one: the controller resolves its codec
 * asynchronously and does not build a source until then, and no source has a report until the
 * first grab completes. In a BACKGROUNDED tab that never happens at all, because capture is
 * driven by requestAnimationFrame — see CLAUDE.md.
 */
/**
 * The controller's own stats (#79), polled. This page used to count paints by wrapping
 * drawImage on the stage canvas, the same trick the marketing page's readout needed, which is
 * why stats() exists. In on-interaction mode the paint rate is the pass criterion: it falls to 0
 * about 600ms after you stop touching the page and comes back the moment you move.
 */
function useStats(handle: MountedRoundTrip | null): RoundTripStats | null {
  const [stats, setStats] = useState<RoundTripStats | null>(null)
  useEffect(() => {
    const read = () => setStats(handle ? handle.stats() : null)
    read()
    const id = window.setInterval(read, 500)
    return () => window.clearInterval(id)
  }, [handle])
  return stats
}

function Report({ handle }: { handle: MountedRoundTrip | null }) {
  const [rep, setRep] = useState<CaptureReport | null | undefined>(undefined)
  const st = useStats(handle)
  /*
   * A coarseness dial and a PEEK, so the specimens can be judged by someone at a screen (#74):
   * at the page's default 0.8 the captions are unreadable in the video, which is the video
   * doing its job and the reviewer not being able to tell which specimen is which. Peek hides
   * the canvas (the live DOM underneath is always there) without stopping the pipeline.
   */
  const [coarse, setCoarse] = useState(0.8)
  const [peek, setPeek] = useState(false)
  useEffect(() => {
    handle?.tune({ coarseness: coarse })
  }, [handle, coarse])
  useEffect(() => {
    const c = document.querySelector<HTMLCanvasElement>('.stage .rt-canvas')
    if (c) c.style.visibility = peek ? 'hidden' : ''
  }, [peek, handle])
  const mode = new URLSearchParams(location.search).get('mode') === 'on-interaction' ? 'on-interaction' : 'continuous'

  const read = React.useCallback(() => {
    setRep(handle ? (handle.report() ?? null) : null)
  }, [handle])

  // Polled, because the report only exists once a frame has actually been captured and there
  // is no event for that. Cheap: it is a property read on the live source.
  useEffect(() => {
    read()
    const id = window.setInterval(read, 500)
    return () => window.clearInterval(id)
  }, [read])

  return (
    <aside className="panel" style={{ position: 'fixed', right: 12, top: 12, zIndex: 50, width: 260 }}>
      <h2>Degradation</h2>
      <pre className="device">{st
        ? `mode             ${mode}
status           ${st.status}
codec            ${st.codec ? `${st.codec.codec} ${st.codec.bitrateMode}` : '-'}
encode / content ${st.encodeSize ? `${st.encodeSize.width}x${st.encodeSize.height}` : '-'} / ${st.contentSize ? `${st.contentSize.width}x${st.contentSize.height}` : '-'}
painted / s      ${st.paintFps}
enc/dec/drop     ${st.encoded}/${st.decoded}/${st.dropped}
moshed / resets  ${st.moshed}/${st.decoderResets}
builds           ${st.builds}`
        : `mode             ${mode}`}</pre>
      <pre className="device">
        {rep
          ? `blocked images   ${rep.blockedImages}
missing fonts    ${rep.missingFonts}
closed roots     ${rep.closedShadowRoots}
iframes          ${rep.iframes}
broken refs      ${rep.brokenReferences}
ancestor bg img  ${rep.ancestorBackgroundImages}
lost decls       ${rep.lostDeclarations}`
          : 'no frame captured yet'}
      </pre>
      <button onClick={read}>re-read</button>
      <label style={{ display: 'block', marginTop: 10 }}>
        coarseness {coarse.toFixed(2)}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={coarse}
          onChange={(e) => setCoarse(Number(e.target.value))}
          style={{ width: '100%' }}
        />
      </label>
      <button onClick={() => setPeek((p) => !p)}>{peek ? 'show video' : 'peek at live page'}</button>
    </aside>
  )
}

/**
 * The stage host. React renders the specimens into this div and then hands the div to
 * mountRoundTrip, which MOVES those children into an .rt-content it creates.
 *
 * That is a deliberate trespass on React's DOM and it is safe only because the specimens are
 * structurally static after mount: React keeps its references to the moved nodes and can still
 * update them in place, but an insertion or removal at this level would be resolved against a
 * parent that no longer holds them. Anything dynamic belongs inside a specimen, not here.
 *
 * The handle is lifted into state rather than a ref so the Report panel re-renders when the
 * mount actually exists. StrictMode's double effect is handled by unmount(), which puts the
 * children back where it found them.
 */
function Hostile() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<MountedRoundTrip | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    // ?mode=on-interaction exercises the wake path (#74); anything else is continuous.
    const params = new URLSearchParams(location.search)
    const mode = params.get('mode') === 'on-interaction' ? 'on-interaction' : 'continuous'
    // ?scale=0.5 is how the vw specimen is judged (#86): the frame must not re-lay out.
    const encodeScale = Number(params.get('scale')) || 1
    const mounted = mountRoundTrip(hostRef.current, {
      className: 'stage',
      coarseness: 0.8,
      gop: 20,
      captureFps: 20,
      captureMode: mode,
      encodeScale,
    })
    setHandle(mounted)
    /*
     * A debug hook, not API. This box is headless and the tab is backgrounded, so the console
     * is the only way to reach the controller — to drive a capture by hand, or to read the
     * report when rAF is suspended and the loop has never run.
     */
    ;(window as unknown as { __rt?: MountedRoundTrip }).__rt = mounted
    return () => {
      setHandle(null)
      mounted.unmount()
    }
  }, [])

  return (
    <>
      <div ref={hostRef} className="hostile-host">
        <Specimens />
      </div>
      <Report handle={handle} />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Hostile />
  </React.StrictMode>,
)
