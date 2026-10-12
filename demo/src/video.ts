import { createForeignObjectSource, mountRoundTrip, type CaptureSource } from '@kcuf.biz/video-round-tripper/core'

/*
 * /video/ — how video survives capture, and the iOS Safari limit that decides how it is captured.
 *
 * Capture has two paths for a <video> (capture/replaceUnserializable.ts):
 *   - COMPOSITED: left as an empty box in the SVG and drawn onto the frame afterwards. Any plain
 *     box video that nothing fixed or sticky overlaps.
 *   - EMBEDDED: the current frame as a PNG data: URI in an <img> inside the SVG. Everything else
 *     (transformed, faded, filtered, masked, rounded, or under a sticky/fixed element).
 *
 * WHY TWO (2026-10-12, measured on the author's iPhone with this page's predecessor, the site's
 * ?videodebug): iOS Safari decodes a large image nested in an SVG-as-image in the BACKGROUND
 * and draws it blank until that finishes. A video frame is a new image every grab, so embedded
 * it is almost never ready: a 240px SVG holding one fresh frame kept it 100% at 64, 128 and
 * 256px square and 0-25% at 384 and 540px. Ruled out one at a time first, all kept 100%: SVG
 * size, the page's markup, a 290KB font stylesheet, onload vs decode(), the live stage running
 * alongside, and the <video> attributes copied onto the <img>.
 *
 * The readout (outside the capture) runs one test per update and saves its tallies to
 * localStorage, because the heavier versions crashed the phone:
 *   composited / embedded   a real capture of the stage, cropped to the first clip, compared
 *                           with that clip's own frame (kept = at least half its opaque pixels match)
 *   NNNpx                   a 240px SVG holding one fresh frame of that size (the threshold)
 * ?reset clears the saved tallies.
 */
type Test = { name: string; kept: number; runs: number; ms: number; note?: string }

const S = 64
const KEY = 'vrt-video-test'
const params = new URLSearchParams(location.search)
if (params.has('reset')) {
  try {
    localStorage.removeItem(KEY)
  } catch {}
}

const stage = document.getElementById('stage')!
const readout = document.getElementById('readout')!
const rt = mountRoundTrip(stage)

const ctx = (w = S, h = S) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c.getContext('2d', { willReadFrequently: true })!
}
const ref = ctx()
const crop = ctx()
const full = ctx()
const frame = ctx()
const out = ctx(240, 240)

/* --- real capture, both paths ----------------------------------------------------------- */

const sources = new Map<string, { el: Element; source: CaptureSource }>()
const sourceFor = (name: string, root: HTMLElement, compositeVideo: boolean) => {
  const known = sources.get(name)
  if (known?.el === root) return known.source
  known?.source.dispose()
  const source = createForeignObjectSource(root, { compositeVideo })
  sources.set(name, { el: root, source })
  return source
}

const captureRun = async (t: Test, compositeVideo: boolean) => {
  const content = stage.querySelector<HTMLElement>('.rt-content')
  const clip = stage.querySelector<HTMLVideoElement>('video[data-test]')
  if (!content || !clip || clip.readyState < 2) return
  ref.clearRect(0, 0, S, S)
  ref.drawImage(clip, 0, 0, S, S)
  const t0 = performance.now()
  let kept = false
  try {
    const f = await sourceFor(t.name, content, compositeVideo).grab(performance.now() * 1000)
    try {
      full.canvas.width = f.displayWidth
      full.canvas.height = f.displayHeight
      full.drawImage(f, 0, 0)
    } finally {
      f.close()
    }
    const c = content.getBoundingClientRect()
    const r = clip.getBoundingClientRect()
    const k = full.canvas.width / c.width
    crop.clearRect(0, 0, S, S)
    crop.drawImage(full.canvas, (r.left - c.left) * k, (r.top - c.top) * k, r.width * k, r.height * k, 0, 0, S, S)
    const a = ref.getImageData(0, 0, S, S).data
    const b = crop.getImageData(0, 0, S, S).data
    let opaque = 0
    let match = 0
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] < 200) continue
      opaque++
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) < 90) match++
    }
    kept = opaque > 0 && match >= opaque / 2
  } catch {
    kept = false
  }
  t.ms += performance.now() - t0
  t.runs++
  if (kept) t.kept++
}

/* --- the size threshold ----------------------------------------------------------------- */

const decodeLoad = async (svg: string) => {
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  try {
    await img.decode()
    return img
  } catch {
    return null
  }
}

const sizeRun = async (t: Test, n: number) => {
  const clip = stage.querySelector<HTMLVideoElement>('video[data-test]')
  if (!clip || clip.readyState < 2) return
  const c = frame.canvas
  c.width = c.height = n
  frame.clearRect(0, 0, n, n)
  frame.drawImage(clip, 0, 0, n, n)
  frame.fillStyle = '#ff00ff'
  frame.fillRect(0, 0, Math.ceil(n / 8), Math.ceil(n / 8))
  const png = c.toDataURL()
  t.note = `${Math.round(png.length / 1024)}KB`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml"><img src="${png}" style="display:block;width:240px;height:240px"/></div></foreignObject></svg>`
  const t0 = performance.now()
  const img = await decodeLoad(svg)
  t.ms += performance.now() - t0
  t.runs++
  if (!img) return
  out.clearRect(0, 0, 240, 240)
  out.drawImage(img, 0, 0)
  // The mark is an eighth of the frame: 30px square at 240, ~900px when kept.
  const px = out.getImageData(0, 0, 240, 240).data
  let mark = 0
  for (let i = 0; i < px.length; i += 4) if (px[i] > 235 && px[i + 1] < 25 && px[i + 2] > 235) mark++
  if (mark >= 300) t.kept++
}

/* --- rotation, readout, persistence ------------------------------------------------------ */

const SIZES = [64, 128, 256, 384, 540]
const tests: { t: Test; run: () => Promise<void> }[] = [
  { t: { name: 'composited', kept: 0, runs: 0, ms: 0 } },
  { t: { name: 'embedded', kept: 0, runs: 0, ms: 0 } },
  ...SIZES.map((n) => ({ t: { name: `${n}px`, kept: 0, runs: 0, ms: 0 } })),
].map(({ t }, i) => ({
  t,
  run: i === 0 ? () => captureRun(t, true) : i === 1 ? () => captureRun(t, false) : () => sizeRun(t, SIZES[i - 2]),
}))

let previous = ''
try {
  previous = localStorage.getItem(KEY) ?? ''
} catch {}
const line = ({ name, kept, runs, ms, note }: Test) =>
  `${name.padEnd(11)}${(note ?? '').padStart(6)}  kept ${kept}/${runs}${runs ? ` (${Math.round((100 * kept) / runs)}%)` : ''}  avg ${runs ? Math.round(ms / runs) : 0}ms`
const save = () => {
  try {
    localStorage.setItem(KEY, `${new Date().toLocaleTimeString()}\n${tests.map(({ t }) => line(t)).join('\n')}`)
  } catch {}
}
const render = () => {
  const st = rt.stats()
  const clip = stage.querySelector<HTMLVideoElement>('video[data-test]')
  readout.textContent = [
    `stage ${st.status}  ${st.codec?.codec ?? '-'}  painted ${st.paintFps.toFixed(1)}/s  blocked ${rt.report()?.blockedImages ?? '-'}`,
    `clip ${clip?.currentSrc.split('/').pop() ?? '-'}  ${clip?.paused ? 'PAUSED' : 'playing'}  ready ${clip?.readyState ?? '-'}`,
    '',
    ...tests.map(({ t }) => line(t)),
    '',
    'composited / embedded: a real capture of the stage, cropped to the first clip',
    'NNNpx: a 240px svg holding one fresh frame of that size (iOS drops >256px)',
    previous ? `\nprevious run, saved ${previous}` : '',
  ].join('\n')
}

let turn = 0
let busy = false
setInterval(() => {
  render()
  if (busy) return
  busy = true
  const { run } = tests[turn++ % tests.length]
  void run()
    .then(save)
    .finally(() => (busy = false))
}, 500)
