<img width="1200" height="630" alt="image" src="https://github.com/user-attachments/assets/e328f579-1f36-4a16-92d1-185d0e751c35" />

# video-round-tripper

Have you ever stared at your website on screen share and thought "boy that looks great"? Then video-round-tripper is for you. 

VRT takes a live webpage, sends it through a video codec, then puts it back on a canvas on top of everything on the page. It renders directly over the existing content and pointer events pass through, so your page still works the same as before. 

```tsx
import { RoundTrip } from '@kcuf.biz/video-round-tripper'

<RoundTrip>
  <YourPage />
</RoundTrip>
```

The component works out of the can if you skip the optional configuration. It probes the device for what codecs exist on it and picks a default configuration for a combination of speed and (intentionally bad) video quality. Read more about the defaults here: 
[Per-codec defaults](#per-codec-defaults-and-the-codec-order).

## Install

```sh
npm install @kcuf.biz/video-round-tripper
```

Or skip the install and drop it onto any page with a script tag:

```html
<script src="https://cdn.jsdelivr.net/npm/@kcuf.biz/video-round-tripper@0.1/dist/roundtrip.iife.js"></script>
<script>
  RoundTripCore.mountRoundTrip(document.body)
</script>
```

React is a peer, `^18.3.1 || ^19`, and **optional**: the `./core` entry and the IIFE contain
no React at all and typecheck with no `@types/react` installed.

| entry | what it is |
|---|---|
| `@kcuf.biz/video-round-tripper` | the React component, plus everything below |
| `@kcuf.biz/video-round-tripper/core` | `createRoundTrip` / `mountRoundTrip`, framework-free |
| `@kcuf.biz/video-round-tripper/iife` | one self-contained file, global `RoundTripCore` |

No CSS to import. The stylesheet is a string injected once per document as `<style data-rt>`,
because a `.css` import is a build-tool contract and an injected `<script>` has no way to
honour it.

### From source

To try unreleased changes, pack a tarball from this repo and point a project at it:

```sh
npm run pack     # -> roundtrip/kcuf.biz-video-round-tripper-<version>.tgz
```

```jsonc
// in the consuming project's package.json
{
  "dependencies": {
    "@kcuf.biz/video-round-tripper":
      "file:../video-round-tripper/roundtrip/kcuf.biz-video-round-tripper-<version>.tgz"
  }
}
```

`npm install` copies the tarball's contents in. npm caches it by name and version, so after
re-packing the same version the consumer needs `npm install --force` (or a version bump) to
pick the new bytes up — a plain `npm install` will silently reuse the old ones.

## Usage

### React (18 or 19)

```tsx
import { RoundTrip } from '@kcuf.biz/video-round-tripper'

export function Page() {
  return (
    <RoundTrip coarseness={0.85} gop={20} mosh={{ dropKeyframesAfter: 0 }}>
      <article>…</article>
    </RoundTrip>
  )
}
```

Give the root a bounded height (`className` + `height: 100dvh`, say) if you want the content to scroll *inside* it with the canvas pinned. With an unbounded root the rule is inert and the page scrolls the canvas away instead of under it. Still useful for localized areas of this effect, but scrolling gets you the most bang for your buck so I recommend it. 

### Astro island

```astro
---
import { RoundTrip } from '@kcuf.biz/video-round-tripper'
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
import { mountRoundTrip } from '@kcuf.biz/video-round-tripper/core'

const handle = mountRoundTrip(document.querySelector('#app'), { coarseness: 0.8 })
// handle.tune({ coarseness: 0.5 })   live dials, no rebuild
// handle.report()                    what the last capture lost
// handle.stats()                     what the stage is doing: codec, sizes, counters, paint rate
// handle.unmount()                   puts the DOM back exactly as it was
```

`mountRoundTrip` **moves** the target's existing children into an `.rt-content` it creates —
it does not clone them, so every listener, every bit of form state and every node identity the
page holds survives. `unmount()` moves them back.

`document.body` is a supported target and gets special treatment: the root takes `100dvh` so
the page scrolls inside the content rather than scrolling the canvas out of view. Pass
`fullHeight: false` to opt out, or `true` to force it on some other element.

Whatever the target inherits from above it — `color`, the font, line height, the root font
size its `rem`s mean — and the ground it sits on, `body`'s or `html`'s background included,
is carried into the capture. Style the page on `body` the ordinary way; there is no need to
move it onto a wrapper element for the round tripper's sake.

### Using it on someone else's page

```js
// paste into the console, or inject as a <script>
RoundTripCore.mountRoundTrip(document.body, {})
```

after loading the IIFE (the script tag under [Install](#install), or `dist/roundtrip.iife.js` from
the package). It defines the global `RoundTripCore` with the same
surface as the `./core` entry. Two things will stop it and neither is worth fighting: a page
served over plain `http://` (WebCodecs is a secure-context API — `VideoEncoder` is simply
`undefined`) and a strict `Content-Security-Policy` that refuses the injected script or the
`data:` URI the rasterizer builds.

## Props worth knowing

| prop | what it does |
|---|---|
| `coarseness` | 0–1. A spectrum of presets configured for each codec with some combination of the below props. Higher makes the effect stronger. Mapped per codec — see `quantizer.ts`. |
| `encodeScale` | 0–1. Encode below display resolution and let the canvas upscale. Very effective; it makes encoding cheaper, not capture. |
| `gop` | Frames between keyframes, or `'infinite'` for none after the first. **G**roup **O**f **P**ictures. With mosh enabled, longer GOPs produce more artifacting before there's a chance for the image to fix itself. Defaults to 20 on AVC/HEVC; on AV1/VP9 it follows `coarseness`. |
| `mosh` | Good old fashioned datamoshing. Drops keyframe chunks *between* encoder and decoder, so P frames apply to a stale reference. `keepEveryNthKeyframe` lets one back through on a rhythm, which is the only thing that clears the bloom on AVC/HEVC — their decoders survive the drop instead of dying and triggering the pipeline's recovery keyframe. |
| `captureFps` | The frame rate at which to capture the page. Default 30. |
| `declaredFramerate` | Only used in bitrate modes. The frame rate we tell the encoder to expect; if this is higher than captured FPS it will allocate fewer bits to each frame and compress them harder.  |
| `rawQuantizer` | Set the quantizer directly, bypassing the `coarseness` setting. Does nothing on VP9/AV1 by default, since those don't use a per-frame quantizer. |
| `bitrate` | Pins the bitrate in the bitrate modes (AV1/VP9 by default). Unlike `coarseness` it doesn't scale with the window, so it looks heavier on a big screen and lighter on a small one. Changing it rebuilds the stage. |
| `source` | Provide a custom capture source. |
| `codec` | A family (`'avc'`), a raw codec string, or `'auto'` (default) to probe. |
| `codecPreference` | The family order `'auto'` sweeps. Defaults to `CODEC_PREFERENCE`. |
| `preferMoshable` | Take H.264/HEVC in any mode the device offers, before the look-first order. Turn it on with `mosh`. Changing it rebuilds the stage. |
| `captureMode` | `'continuous'` or `'on-interaction'`. |
| `disabled` | Bypass. Defaults to on under `prefers-reduced-motion`. |
| `onCodec` | Called once per pipeline build with the codec the probe picked and the dials resolved against it — the only way to read the values a left-undefined dial landed on. |

The vanilla `mountRoundTrip(target, opts)` and `createRoundTrip(opts)` take the same options, plus `onStatus(status, message)`, called on every status change (`idle`, `running` once a frame has painted, `unsupported` where WebCodecs or every codec is missing, `error` with a message).

`coarseness`, `gop` and `mosh` are the three with per-codec defaults. Leaving one `undefined` uses the default.

## Per-codec defaults

The probe order is **`avc → hevc → vp9 → av1`**. The order is based on what produces the most interesting artifacts as opposed to the speed (all four are realtime on an M4 Mac mini in Chrome: at 864x544, avc1 4.1ms/frame, vp09 4.2, av01 5.2).

Not all codecs can produce the classic datamosh effect. We start with AVC and HEVC on a fixed quantizer, which is compatible with moshing. But many devices can't handle that and will instead go for VP9. VP9 and AV1 have different artifact styles and methods of generation. To get artifacts out of VP9 and AV1 we have to cut the bitrate dramatically to starve frames to get the effect. Pass `preferMoshable` to ask for H.264 in whatever mode the device has instead, which is what you want with `mosh` on.

AVC and HEVC tend to produce more interesting artifacts because they care less if they are broken. Rather than breaking outright on a missing keyframe, they can still continue to decode movement data from the delta frames. AV1 and VP9 are both a bit newer and a bit more robust, but this makes them handle errors more gracefully and produce less interesting artifacts. So for those we essentially do the inverse: we starve them on a fixed bitrate. Keyframes are bit-heavy, so they come out exceptionally blocky, then the picture slowly heals until the next one. Coarseness sets how starved and how often. Here's a better explanation from Claude:

> Moshing is a *decoder* phenomenon — the whole effect is what a decoder does with a delta whose keyframe it never received. H.264 and HEVC reset their entropy coder (CABAC) at every slice, so a delta that arrives after a dropped IDR still **parses** perfectly: only the reference pixels are wrong, the motion vectors drag stale texture around, and you get the classic smear. VP9 and AV1 instead carry backward-adapted probability contexts *across* frames, and the keyframe is what resets them — drop it and the decoder's contexts no longer match the encoder's, so the deltas are bit-level gibberish rather than wrong-but-valid pixels. VP9's decoder rejects the very first post-drop delta (0 moshed frames, software and hardware alike). AV1's hardware decoder emits one or two frames of garbage arranged in the encoder's tile grid and then errors.

So the defaults differ by family, the goal being to try to get satisfying artifacts:

| family | coarseness | gop | mosh |
|---|---|---|---|
| avc, hevc | 0.78 | 20 | drop every keyframe, keeping every 3rd — bloom, collapse, snap back |
| av1, vp9 | 0.78 | follows coarseness (about 5 at 0.78) | off; moshing is opt-in because it does not produce the look |

They are resolved *after* the probe, because that is the first moment the family is known. A codec string's level is derived from the coded area for the same reason: `avc1.42001f` is Baseline 3.1, caps at 921,600 px, and silently vanishes from the probe on any laptop viewport.

**The decoder is expected to die under moshing and comes back on its own.** Dropping a keyframe leaves later deltas referencing state the decoder never got; a conformant decoder answers with a decoding error, and a `VideoDecoder` that errors is closed. The pipeline rebuilds it, asks the encoder for a keyframe and lets that one through.

## Stats

A page that wants to show what the stage is doing polls `stats()` — on the vanilla handle and on the controller from `createRoundTrip`.

```js
handle.stats()
// { status: 'running', codec: { codec: 'avc1.64001f', family: 'avc', bitrateMode: 'quantizer', … },
//   encodeSize: { width: 402, height: 302 }, contentSize: { width: 401, height: 301 },
//   encoded: 812, decoded: 809, dropped: 3, moshed: 40, decoderResets: 0,
//   painted: 809, paintFps: 19, builds: 1 }
```

- `status` — the same values the vanilla `onStatus` option reports; `running` only once this build has painted.
- `encodeSize` is the encoder's frame (even, for 4:2:0); `contentSize` is the part of it the
  content fills and is the canvas's backing size.
- The counters and `painted` are **per build**: a resize rebuilds the encoder and they restart
  at 0, with `builds` going up.
- `paintFps` is measured over the last second, not derived from `captureFps`. It drops when
  backpressure or moshing withholds frames, and falls to 0 on its own when nothing paints
  (on-interaction idle, a hidden tab).
- Bypassed (reduced motion) or unmounted, it reads idle: nulls and zeros.

## The degradation report

Count the number of things that didn't make it in to or out of the round tripper.

```js
handle.report()
// { blockedImages: 1, missingFonts: 0, closedShadowRoots: 1, iframes: 1,
//   brokenReferences: 1, ancestorBackgroundImages: 0, lostDeclarations: 0 }
```

Available on the vanilla handle and on the controller from `createRoundTrip`. Will be `undefined` if the codec probe is incomplete and no frame has been captured yet. (A page in a background tab reports `undefined` forever: capture runs on `requestAnimationFrame`, which Chrome suspends entirely when the tab is hidden.)

- `blockedImages` — images, canvases and videos replaced by a flat grey block: CORS refused,
  or the canvas was tainted.
- `missingFonts` — `@font-face` files that could not be inlined, so that text fell back.
- `closedShadowRoots` — custom elements that appear to hide a closed root (a heuristic).
- `iframes` — always placeholdered, see below.
- `brokenReferences` — `url(#id)` / `href="#id"` on SVG elements (gradients, patterns, masks,
  filters, clip-paths, `<use>`) whose target is outside the captured subtree. SVG paints a
  missing paint server as `none`, so each one is something that vanished. The usual cause is
  a `<RoundTrip>` around part of a page whose `<defs>` or icon sprite sits above it.
- `ancestorBackgroundImages` — a background image on an ancestor whose box is not the
  capture's own (`html`/`body` are always carried). Its colour is carried; the image would be
  positioned against a box the clone does not have, so it is left out and counted.
- `lostDeclarations` — CSS rules whose `var()` shorthand the browser dropped from the rule's
  text and whose original source could not be recovered (constructed stylesheets keep none),
  so a background or similar is missing from the capture.

The page's markup needs to be able to be parsed by an XML parser, the whole frame will fail if it doesn't. So the capture strips anything in HTML that is incompatible with XML. Comments containing `--`, framework directive attributes like Alpine's `@click` and `:class`, control characters. If a frame fails to decode for a different reason, the error will name it and the offending markup to help debugging. There's a demo page at `demo/hostile/` with one specimen per case where you can see the failures as well as the report.

## What cannot work

The following can't be encoded by the round tripper and will fail to gray placeholders instead:

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
- **Some CSS motion.** The clone's own SVG timeline is always `t=0`, so motion is snapshotted
  rather than replayed: `capture/animations.ts` pins every animated property's current computed
  value inline, the root's resolved custom properties are carried down, and whatever the
  subtree inherits from its ancestors is read fresh every frame. Effects that are not
  `KeyframeEffect`s, and effects targeting a pseudo-element, are skipped: there is no inline
  style to write them to.
- **The text caret and text selection.** `:hover`, `:active`, `:focus`, `:focus-visible` and
  `:focus-within` are carried into the capture, but the caret and a selection highlight are not
  in the DOM at all.
- **Insecure origins.** WebCodecs is secure-context only.

## The two ideas it is built on

**Everything is still there under the canvas.** The children stay fully rendered and fully interactive. The canvas is an opaque sibling laid on top with `pointer-events: none` and `aria-hidden="true"`, so the browser's own hit-testing delivers clicks, hover, focus, selection and IME straight to the real element underneath. No event forwarding, no coordinate mapping — and synthesized events could not drive `:hover`, `:focus-visible` or native text selection anyway.

This is deliberately not `opacity: 0`. If we made everything `opacity: 0` it would be transparent so a renderer couldn't capture it!

**Bad on purpose.** There is probably a way to configure a video pipeline to produce decent looking realtime video capture from a webpage. But that isn't the goal. The goal is to look bad, but in a cool way 😎

## Capture

This part mostly goes over my head so I'll leave it to Claude:

> There is no fast, permissionless browser API that rasterizes arbitrary live DOM to frames. This uses element-scoped `foreignObject` rasterization serialized to a data URI — measured at **8ms median / 18ms p95 (~125fps)** on the demo page in Chrome 150, untainted, with full font fidelity. That is ~3x faster than the best library tried, with no dependency.

> `getDisplayMedia()` was rejected: it captures the composite, which now includes the opaque overlay canvas, so it feeds itself an infinite video-feedback mirror. (A legitimate effect to reach for deliberately — just not as the default.)

> Everything that separates "works on the page we authored" from "works on any page" lives in `roundtrip/src/capture/`: stylesheet inlining, `<img>`/`<canvas>`/`<video>` replacement, shadow DOM flattening, scroll/fixed/sticky positioning, form state. `inlineResources.ts` composes the passes and documents the order they have to run in.

## Development

This repo holds two npm workspaces: `roundtrip/`, the library itself, and `demo/`, its test
pages (`/` the React demo, `/hostile/` the capture torture test, `/compare/` the four codecs
side by side, `/video/` the video capture paths).

```
npm install
npm run dev        # the demo pages on 127.0.0.1:5394
npm test           # pure modules, no jsdom
npm run typecheck
npm run build      # the demo
npm run build:lib  # roundtrip/dist — ESM entries, the IIFE, declarations
npm run pack       # the tarball, beside dist
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the demo pages, testing (in real Chrome, and why) and
releases. [ARCHITECTURE.md](ARCHITECTURE.md) is how it works, and the gotchas: several of them
cost real time and none are caught by `tsc`.

---

[KCUF](https://kcuf.biz) is a design practice making stupid tools for stupid people
