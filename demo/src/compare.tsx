import { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { bitrateFor, gopFor, mountRoundTrip, RATE_CONTROL, type CodecFamily, type MountedRoundTrip } from '@kcuf.biz/video-round-tripper'
import './index.css'

/**
 * #72: the same content through all four codec families at once, at ONE coarseness.
 *
 * The acceptance test for quantizer.ts's FLOOR table is that a given coarseness looks about the
 * same whichever codec is underneath, and that can only be judged by eye, side by side. Mosh is
 * OFF and GOP infinite in every stage, so what differs is compression alone: avc/hevc's default
 * mosh would otherwise make them look worse for a reason the floor has nothing to do with.
 *
 * avc/hevc: the floor inputs are live — each stage is driven with rawQuantizer = floor + (max -
 * floor) * coarseness, exactly what quantizerFor() computes, so a floor that looks right here can
 * be copied into the table verbatim.
 * av1/vp9: coarseness is a starved constant bitrate there (RATE_CONTROL in quantizer.ts), so
 * those stages just follow the slider and show the bitrate it asks for, with the keyframe
 * interval also following the dial (gopFor): their static page only breaks on keyframes.
 */

const FAMILIES: CodecFamily[] = ['avc', 'hevc', 'av1', 'vp9']
const MAX: Record<CodecFamily, number> = { avc: 51, hevc: 51, av1: 63, vp9: 63 }
// Mirrors quantizer.ts FLOOR at the time this page was written; the page shows the values it uses.
const TABLE: Record<CodecFamily, number> = { avc: 18, hevc: 10, vp9: 24, av1: 32 }

const qFor = (f: CodecFamily, floor: number, c: number) => Math.round(floor + (MAX[f] - floor) * c)
const byRate = (f: CodecFamily) => RATE_CONTROL[f] === 'constant'

/** Saturated type, fine text, a gradient, a photo and hairlines: each fails differently. */
function Content() {
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = (t: number) => {
      if (bar.current) bar.current.style.transform = `translateX(${(Math.sin(t / 1400) * 0.5 + 0.5) * 220}px)`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="cmp-content">
      <h1>Chroma bleed</h1>
      <p>
        Small body text at 13px, the thing blocking eats first. The quick brown fox jumps over the
        lazy dog, 0123456789.
      </p>
      <div className="cmp-row">
        <img src="/tile.png" alt="" />
        <div className="cmp-grad" />
      </div>
      <div className="cmp-lines" />
      <div className="cmp-track">
        <div ref={bar} className="cmp-bar">now</div>
      </div>
    </div>
  )
}

function Stage({ family, q, c, onReady }: { family: CodecFamily; q: number; c: number; onReady: (f: CodecFamily, h: MountedRoundTrip) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('starting')
  const [codec, setCodec] = useState('')
  const [mode, setMode] = useState('')
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    if (!host.current) return
    const h = mountRoundTrip(host.current, {
      codec: family,
      mosh: false,
      // avc/hevc: GOP 20 (no visible effect with mosh off, the encoder is closed-loop).
      // av1/vp9: left unset, so it follows coarseness (gopFor) like a bare <RoundTrip> would.
      gop: byRate(family) ? undefined : 20,
      coarseness: c,
      rawQuantizer: byRate(family) ? undefined : q,
      captureFps: 20,
      onStatus: (s, m) => setStatus(s === 'running' ? 'running' : `${s}: ${m}`),
      onCodec: (choice) => {
        setCodec(choice.codec)
        setMode(choice.bitrateMode)
      },
    })
    setBox({ w: host.current.offsetWidth & ~1, h: host.current.offsetHeight & ~1 })
    onReady(family, h)
    return () => h.unmount()
    // q is applied live through tune(); mounting once per family is the point.
  }, [family])
  return (
    <figure className="cmp-stage">
      <figcaption>
        <b>{family}</b>{' '}
        {mode === 'constant' ? `${Math.round(bitrateFor(c, box.w, box.h) / 1000)} kbps, key every ${gopFor(c)}` : `q${q}`}{' '}
        <span>
          {codec || status} {mode}
        </span>
      </figcaption>
      <div ref={host} className="cmp-host">
        <Content />
      </div>
    </figure>
  )
}

function Compare() {
  const params = new URLSearchParams(location.search)
  const [c, setC] = useState(Number(params.get('c') ?? 0.78))
  const [floors, setFloors] = useState<Record<CodecFamily, number>>(() => {
    const f = { ...TABLE }
    for (const fam of FAMILIES) {
      const v = params.get(fam)
      if (v !== null && Number.isFinite(Number(v))) f[fam] = Number(v)
    }
    return f
  })
  const handles = useRef(new Map<CodecFamily, MountedRoundTrip>())

  useEffect(() => {
    for (const f of FAMILIES) {
      const h = handles.current.get(f)
      if (byRate(f)) h?.tune({ coarseness: c })
      else h?.tune({ rawQuantizer: qFor(f, floors[f], c) })
    }
    // Keep the URL shareable: whatever the author is looking at can be sent back verbatim.
    const p = new URLSearchParams({ c: String(c), ...Object.fromEntries(FAMILIES.map((f) => [f, String(floors[f])])) })
    history.replaceState(null, '', `?${p}`)
  }, [c, floors])

  return (
    <div className="cmp">
      <div className="cmp-controls panel">
        <label>
          coarseness <b>{c.toFixed(2)}</b>
          <input type="range" min={0} max={1} step={0.01} value={c} onChange={(e) => setC(Number(e.target.value))} />
        </label>
        {FAMILIES.filter((f) => !byRate(f)).map((f) => (
          <label key={f}>
            {f} floor
            <input
              type="number"
              min={0}
              max={MAX[f]}
              value={floors[f]}
              onChange={(e) => setFloors({ ...floors, [f]: Number(e.target.value) })}
            />
            <span>(table {TABLE[f]})</span>
          </label>
        ))}
      </div>
      <div className="cmp-grid">
        {FAMILIES.map((f) => (
          <Stage key={f} family={f} q={qFor(f, floors[f], c)} c={c} onReady={(fam, h) => handles.current.set(fam, h)} />
        ))}
      </div>
    </div>
  )
}

const css = `
.cmp { padding: 12px; }
.cmp-controls { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-bottom: 12px; }
.cmp-controls input[type=number] { width: 52px; margin-left: 6px; }
.cmp-controls input[type=range] { width: 200px; vertical-align: middle; margin-left: 6px; }
.cmp-controls span { color: var(--muted); margin-left: 4px; }
.cmp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; }
.cmp-stage { margin: 0; }
.cmp-stage figcaption { margin-bottom: 4px; }
.cmp-stage figcaption span { color: var(--muted); margin-left: 8px; }
.cmp-host { height: 360px; }
.cmp-content { height: 360px; box-sizing: border-box; padding: 14px; background: #2b6f4a; color: #fff; overflow: hidden; }
.cmp-content h1 { margin: 0 0 6px; font: 700 34px/1.1 Georgia, serif; color: #ff2a6d; }
.cmp-content p { margin: 0 0 10px; font-size: 13px; }
.cmp-row { display: flex; gap: 10px; height: 110px; }
.cmp-row img { height: 110px; width: 140px; object-fit: cover; }
.cmp-grad { flex: 1; background: linear-gradient(90deg, #0a1f7a, #ffd400); }
.cmp-lines { height: 40px; margin-top: 10px; background: repeating-linear-gradient(90deg, #fff 0 1px, transparent 1px 5px); }
.cmp-track { position: relative; height: 40px; margin-top: 10px; }
.cmp-bar { position: absolute; left: 0; top: 0; width: 70px; height: 40px; background: #00e5ff; color: #000; font: 700 16px/40px monospace; text-align: center; }
`
const style = document.createElement('style')
style.textContent = css
document.head.append(style)

ReactDOM.createRoot(document.getElementById('root')!).render(<Compare />)
