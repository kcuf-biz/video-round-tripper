# video-round-tripper

Round-trips a live web page through a video codec and paints the result back over it.

The point is not fidelity. The point is to put video compression artifacts into a web page
experience and see what they do to it: blocking, banding, ringing, chroma bleed on saturated
type, an interface that macroblocks when you scroll and settles when you stop.

```tsx
import { RoundTrip } from '@video-round-tripper/roundtrip'

<RoundTrip>
  <YourPage />
</RoundTrip>
```

That bare form is the intended one. With no dials set, the piece probes the device, picks a
codec, and fills in coarseness, GOP and mosh from that codec's own defaults — see
[Per-codec defaults](#per-codec-defaults-and-the-codec-order).

## Install

Not on any registry, and not going on one. Consumption is a tarball.

```sh
# in this repo
npm run pack     # -> roundtrip/video-round-tripper-roundtrip-0.1.0.tgz
```

```jsonc
// in the consuming project's package.json
{
  "dependencies": {
    "@video-round-tripper/roundtrip":
      "file:../video-round-tripper/roundtrip/video-round-tripper-roundtrip-0.1.0.tgz"
  }
}
```

`npm install` copies the tarball's contents in. npm caches it by name and version, so after
re-packing the same version the consumer needs `npm install --force` (or a version bump) to
pick the new bytes up — a plain `npm install` will silently reuse the old ones.

React is a peer, `^18.3.1 || ^19`, and **optional**: the `./core` entry and the IIFE contain
no React at all and typecheck with no `@types/react` installed.

| entry | what it is |
|---|---|
| `@video-round-tripper/roundtrip` | the React component, plus everything below |
| `@video-round-tripper/roundtrip/core` | `createRoundTrip` / `mountRoundTrip`, framework-free |
| `@video-round-tripper/roundtrip/iife` | one self-contained file, global `RoundTripCore` |

No CSS to import. The stylesheet is a string injected once per document as `<style data-rt>`,
because a `.css` import is a build-tool contract and an injected `<script>` has no way to
honour it.

## Usage

### React (18 or 19)

```tsx
import { RoundTrip } from '@video-round-tripper/roundtrip'

export function Page() {
  return (
    <RoundTrip coarseness={0.85} gop={20} mosh={{ dropKeyframesAfter: 0 }}>
      <article>…</article>
    </RoundTrip>
  )
}
```

Give the root a bounded height (`className` + `height: 100dvh`, say) if you want the content
to scroll *inside* it with the canvas pinned. With an unbounded root the rule is inert and the
page scrolls the canvas away instead of under it. Scrolling is the strongest motion the piece
gets, so this is worth doing.

### Astro island

```astro
---
import { RoundTrip } from '@video-round-tripper/roundtrip'
---
<RoundTrip client:load coarseness={0.8} className="stage">
  <slot />
  <h1>Whatever the page already was</h1>
  <p>Static HTML is ideal here — it is exactly what capture wants.</p>
</RoundTrip>
```

Needs `@astrojs/react` in the integrations list, and `client:load` (or `client:visible`) —
without a client directive the island never hydrates, so nothing ever mounts and you get the
plain children. Astro renders the slotted children to static HTML and hands them to the island
as `children`, which is the best case for the rasterizer: no framework state to project, no
hydration mismatch to capture mid-flight.

`className`, not `class`: the props go straight to a React component. And **style the stage
from a global sheet, not a scoped `<style>`.** Astro rewrites a component's
`<style>` to `.stage[data-astro-cid-…]`, and the root div is created by React inside the
island, so it never carries that attribute and the rule silently does not apply. Measured in a
consumer app: with a scoped rule the root came out 268px tall instead of `100vh`, which is not
an error — it just quietly stops being a scroll container. `<style is:global>`, a global
stylesheet, or an inline `style={{ height: '100dvh' }}` all work.

### A plain page, no framework

```js
import { mountRoundTrip } from '@video-round-tripper/roundtrip/core'

const handle = mountRoundTrip(document.querySelector('#app'), { coarseness: 0.8 })
// handle.tune({ coarseness: 0.5 })   live dials, no rebuild
// handle.report()                    what the last capture lost
// handle.unmount()                   puts the DOM back exactly as it was
```

`mountRoundTrip` **moves** the target's existing children into an `.rt-content` it creates —
it does not clone them, so every listener, every bit of form state and every node identity the
page holds survives. `unmount()` moves them back.

`document.body` is a supported target and gets special treatment: the root takes `100dvh` so
the page scrolls inside the content rather than scrolling the canvas out of view. Pass
`fullHeight: false` to opt out, or `true` to force it on some other element.

### Injecting into a page you do not own

```js
// paste into the console, or inject as a <script>
RoundTripCore.mountRoundTrip(document.body, {})
```

after loading `dist/roundtrip.iife.js`. It defines the global `RoundTripCore` with the same
surface as the `./core` entry. Two things will stop it and neither is worth fighting: a page
served over plain `http://` (WebCodecs is a secure-context API — `VideoEncoder` is simply
`undefined`) and a strict `Content-Security-Policy` that refuses the injected script or the
`data:` URI the rasterizer builds.

## Props worth knowing

| prop | what it does |
|---|---|
| `coarseness` | 0–1. The main dial. Mapped per codec — see `quantizer.ts`. |
| `encodeScale` | 0–1. Encode below display resolution and let the canvas upscale. Cheap, very effective. |
| `declaredFramerate` | The lie. Tell the rate controller 60 while feeding it 6 and it starves itself. |
| `gop` | `'infinite'` never sends another keyframe, so error never gets corrected. |
| `mosh` | Drops keyframe chunks *between* encoder and decoder, so deltas apply to a stale reference. The classic bloom. |
| `codec` | A family (`'avc'`), a raw codec string, or `'auto'` (default) to probe. |
| `codecPreference` | The family order `'auto'` sweeps. Defaults to `CODEC_PREFERENCE`. |
| `captureMode` | `'continuous'` or `'on-interaction'`. |
| `disabled` | Bypass. Defaults to on under `prefers-reduced-motion`. |
| `onCodec` | Called once per pipeline build with the codec the probe picked and the dials resolved against it — the only way to read the values a left-undefined dial landed on. |

`coarseness`, `gop` and `mosh` are the three with per-codec defaults. Leaving one `undefined`
is how you ask for the default; `0`, `false` and `'infinite'` are explicit answers and win.

## Per-codec defaults, and the codec order

The probe order is **`avc → hevc → av1 → vp9`**, always, and it is not about speed (all four
are realtime here: at 864x544, avc1 4.1ms/frame, vp09 4.2, av01 5.2). It is about which ones
can produce the look.

Moshing is a *decoder* phenomenon — the whole effect is what a decoder does with a delta whose
keyframe it never received. H.264 and HEVC reset their entropy coder (CABAC) at every slice,
so a delta that arrives after a dropped IDR still **parses** perfectly: only the reference
pixels are wrong, the motion vectors drag stale texture around, and you get the classic smear.
VP9 and AV1 instead carry backward-adapted probability contexts *across* frames, and the
keyframe is what resets them — drop it and the decoder's contexts no longer match the
encoder's, so the deltas are bit-level gibberish rather than wrong-but-valid pixels. VP9's
decoder rejects the very first post-drop delta (0 moshed frames, software and hardware alike).
AV1's hardware decoder emits one or two frames of garbage arranged in the encoder's tile grid
and then errors. Neither is a bug and no configuration changes it; `CLAUDE.md` has the
measurements.

So the defaults differ by family:

| family | coarseness | gop | mosh |
|---|---|---|---|
| avc, hevc | 0.78 | 20 | drop every keyframe — the classic bloom, out of the box |
| av1, vp9 | 0.78 | `infinite` | off; moshing is opt-in because it does not produce the look |

They are resolved *after* the probe, because that is the first moment the family is known. A
codec string's level is derived from the coded area for the same reason: `avc1.42001f` is
Baseline 3.1, caps at 921,600 px, and silently vanishes from the probe on any laptop viewport.

**The decoder is expected to die under moshing and comes back on its own.** Dropping a
keyframe leaves later deltas referencing state the decoder never got; a conformant decoder
answers with a decoding error, and a `VideoDecoder` that errors is closed. The pipeline
rebuilds it, asks the encoder for a keyframe and lets that one through. Bloom, collapse, snap
to clean, bloom again — that cycle *is* datamoshing, not a fault being papered over.

## The degradation report

The piece is made of things rendering wrong on purpose, which makes an accidental failure
invisible: a grey rectangle where a photo should be reads as an artifact. So every capture
counts what it had to give up on.

```js
handle.report()
// { blockedImages: 1, missingFonts: 0, closedShadowRoots: 1, iframes: 1 }
```

Available on the vanilla handle and on the controller from `createRoundTrip`. `undefined`
means there is nothing to report *on* yet — the codec probe is async and no frame has been
captured — which is a different answer from zeroes. (A page in a background tab reports
`undefined` forever: capture runs on `requestAnimationFrame`, which Chrome suspends entirely
when the tab is hidden. That is correct behaviour, not a failure.)

- `blockedImages` — images, canvases and videos replaced by a flat grey block: CORS refused,
  or the canvas was tainted.
- `missingFonts` — `@font-face` files that could not be inlined, so that text fell back.
- `closedShadowRoots` — custom elements that appear to hide a closed root (a heuristic).
- `iframes` — always placeholdered, see below.

`demo/hostile/` is a page with one specimen per case, and shows the report live.

## What cannot work

Not "not yet" — these are structural, and each one degrades to a visible grey placeholder or a
fallback rather than throwing.

- **iframes.** The rasterizer serializes an SVG and loads it through `<img>`; that document is
  not allowed to load subresources, let alone a nested browsing context. A same-origin iframe
  could in principle be walked and inlined as markup; a cross-origin one never can.
- **Closed shadow roots.** There is no API that reaches inside one. The host serializes as
  whatever light DOM it has, which is usually nothing. Open roots *are* flattened in, slots,
  `:host` rules, `adoptedStyleSheets` and all.
- **WebGL canvases without `preserveDrawingBuffer: true`.** The drawing buffer is cleared
  after compositing, so `toDataURL()` returns a blank image. Pass that context attribute and
  it captures fine, at a cost to the host page's own performance.
- **Fonts and images that refuse CORS.** Everything is fetched and inlined as a `data:` URI,
  because the SVG document cannot fetch anything itself. A server that sends no
  `Access-Control-Allow-Origin` cannot be worked around from the page.
- **Anything animated purely in CSS.** An `<img>`-loaded SVG gets a fresh timeline on every
  load and capture builds a new `Image` per frame, so a CSS keyframe animation renders at
  `t=0` forever — perfect in the live DOM, frozen in the video. Measured: two captures 650ms
  apart differed by 58.4% of pixels for a JS-driven gradient and 0.0% for a CSS-keyframed one.
  Drive anything that moves from rAF into `element.style`.
- **Insecure origins.** WebCodecs is secure-context only.

## The two ideas it is built on

**Occlusion, not hiding.** The children stay fully rendered and fully interactive. The canvas
is an opaque sibling laid on top with `pointer-events: none` and `aria-hidden="true"`, so the
browser's own hit-testing delivers clicks, hover, focus, selection and IME straight to the real
element underneath. No event forwarding, no coordinate mapping — and synthesized events could
not drive `:hover`, `:focus-visible` or native text selection anyway.

This is deliberately *not* `opacity: 0`. Transparency preserves the same interaction properties,
but it breaks capture: rasterizers apply opacity during paint, so a transparent subtree encodes
as transparent pixels. You cannot capture what you have made invisible.

The effect that falls out of this is the piece: hovering a button fires the real `:hover`, which
lands in the next captured frame, and reaches you several frames late and artifact-ridden.

**The encoder is misconfigured on purpose.** A normal pipeline is tuned to hide artifacts; this
one is tuned to produce them. Low bitrate, coarse quantizer, long GOP so error accumulates, and
optional keyframe suppression. Those are props, not constants.

## Capture

There is no fast, permissionless browser API that rasterizes arbitrary live DOM to frames. This
uses element-scoped `foreignObject` rasterization serialized to a data URI — measured at **8ms
median / 18ms p95 (~125fps)** on the demo page in Chrome 150, untainted, with full font fidelity.
That is ~3x faster than the best library tried, with no dependency.

`getDisplayMedia()` was rejected: it captures the composite, which now includes the opaque
overlay canvas, so it feeds itself an infinite video-feedback mirror. (A legitimate effect to
reach for deliberately — just not as the default.)

Everything that separates "works on the page we authored" from "works on any page" lives in
`roundtrip/src/capture/`: stylesheet inlining, `<img>`/`<canvas>`/`<video>` replacement, shadow
DOM flattening, scroll/fixed/sticky positioning, form state. `inlineResources.ts` composes the
passes and documents the order they have to run in.

## Development

```
npm install
npm run dev        # 127.0.0.1:5394 — /  is the demo, /hostile/ the capture torture test
npm test           # pure modules, no jsdom
npm run typecheck
npm run build      # the demo
npm run build:lib  # roundtrip/dist — ESM entries, the IIFE, declarations
npm run pack       # the tarball, beside dist
```

See `CLAUDE.md` for the gotchas — several of them cost real time and none are caught by `tsc`.
