import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { RoundTrip, createForeignObjectSource } from '@video-round-tripper/roundtrip'
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
 * Wrapped in <RoundTrip> for now. The vanilla mountRoundTrip path is being built in parallel
 * and this page switches over to it once it lands.
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

if (!customElements.get('shadow-specimen')) customElements.define('shadow-specimen', ShadowSpecimen)
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
 * Drawn from JS, never from CSS or a bare rAF. A canvas is only ever as current as the last
 * time something drew into it, and CSS animations do not survive capture at all — an
 * <img>-loaded SVG restarts its timeline on every load, so a keyframed anything renders at
 * t=0 forever.
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

/** Local copy: the package's exports map only exposes the root, which does not re-export it. */
interface CaptureReport {
  blockedImages: number
  missingFonts: number
  closedShadowRoots: number
  iframes: number
}

/**
 * OUTSIDE .rt-content, like every other control on every page here: anything inside that
 * subtree is captured and round-tripped, so a panel reporting on the artifacts would be
 * encoded into them.
 *
 * It runs its own throwaway capture rather than reading the component's. RoundTrip builds its
 * source internally at the ENCODER's dimensions and does not expose it; handing it an external
 * source instead would decouple the frame size from the encoder config. One extra grab is the
 * cheaper mistake.
 */
function Report() {
  const [rep, setRep] = useState<CaptureReport | null>(null)
  const [ms, setMs] = useState(0)
  const [err, setErr] = useState('')

  const scan = React.useCallback(async () => {
    const el = document.querySelector<HTMLElement>('.rt-content')
    if (!el) return
    const source = createForeignObjectSource(el)
    try {
      const t0 = performance.now()
      const frame = await source.grab(0)
      frame.close()
      setMs(performance.now() - t0)
      setRep(source.report?.() ?? null)
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      source.dispose()
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  return (
    <aside className="panel" style={{ position: 'fixed', right: 12, top: 12, zIndex: 50, width: 260 }}>
      <h2>Degradation</h2>
      <pre className="device">
        {err
          ? `error: ${err}`
          : rep
            ? `blocked images   ${rep.blockedImages}
missing fonts    ${rep.missingFonts}
closed roots     ${rep.closedShadowRoots}
iframes          ${rep.iframes}
grab             ${ms.toFixed(0)}ms (cold)`
            : 'scanning…'}
      </pre>
      <button onClick={() => void scan()}>re-scan</button>
    </aside>
  )
}

function Hostile() {
  return (
    <>
      <RoundTrip className="stage" coarseness={0.8} gop={20} captureFps={20}>
        <Specimens />
      </RoundTrip>
      <Report />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Hostile />
  </React.StrictMode>,
)
