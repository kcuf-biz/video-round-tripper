# Architecture and engineering notes

How video-round-tripper works, and every lesson that cost real debugging time. Read the
**Gotchas** before changing capture, the codec pipeline or the package build: most of them
describe a failure that was silent (a black canvas, a frozen frame, the wrong font) rather
than an error.

**Where the numbers come from.** This project is built agent-led: coding agents write the code
and run the experiments, and the author reviews by eye. Every figure here was measured directly
by those agents, not estimated, unless it says otherwise. "This machine", "this box" and "the
M4" are the author's Mac mini M4 (Chrome with Apple's hardware encoders, VideoToolbox), driven
headless; "by eye" means the author at a real screen; phone results are from the author's
iPhone. The KCUF splash page (kcuf.biz) and the project's marketing page are the author's
other pages built on this library; several bugs were found on them.

**The `(#62)`-style numbers** are the author's own issue tracker, which is not public. They
are kept as labels, so a note, a code comment and its test can be found together with one
search; nothing needs the tracker to make sense.

## Layout and entry points
npm workspaces. In development `roundtrip/` is a **source-only** package: its `exports` map points straight at `./src/index.ts`, there is
no build step, and `demo/` consumes it via workspace link. That is why `demo/vite.config.ts`
sets `optimizeDeps.exclude: ['@kcuf.biz/video-round-tripper']` and why imports carry explicit
`.ts`/`.tsx` extensions (`allowImportingTsExtensions`). For anything outside this repo there
is a real build — see **Package shape** below; `exports` stays on `src` so the dev loop
survives it.

Three entry points, one loop:

- **`RoundTrip.tsx`** — the React component. Refs, one effect whose dependency array says which
  options force a rebuild, and the reduced-motion bypass. Nothing else.
- **`core/createRoundTrip.ts`** — the loop, framework-free: ResizeObserver + debounce, probe,
  pipeline, capture source, pacer, wake listeners, rAF, and the VideoFrame ownership
  discipline. `{ tune, report, dispose }`. The split follows the line React already drew —
  whatever the effect's deps listed is construction-time here (codec and dimensions are fixed
  at `configure()`), whatever went through the dials ref is tunable in place.
- **`mount.ts`** — `mountRoundTrip(target, opts)` for a plain page. MOVES the target's existing
  children into `.rt-content` rather than cloning, so listeners, form state and node identity
  survive; `unmount()` puts them back.

```
CaptureSource.grab() -> VideoFrame -> VideoEncoder -> EncodedVideoChunk
  -> mosh filter (drop chunks) -> VideoDecoder -> VideoFrame -> drawImage
```

- `capture/foreignObjectSource.ts` — the default rasterizer. Hand-rolled, no dependency.
- `capture/` — **the drop-anywhere seam**, everything separating "works on the page we
  authored" from "works on any page". `inlineResources.ts` is the entry (`prepareClone` +
  `createResourceCache`) and composes `cssResources.ts` (every stylesheet's fonts and images
  inlined as data: URIs), `replaceUnserializable.ts` (img/canvas/video/iframe — pixels that
  are not markup), `positioning.ts` (scroll, fixed, sticky), `shadowDom.ts` (open roots
  flattened) over the shared pairing in `pairs.ts`; `interactionState.ts` (:hover/:active/:focus
  as `data-rt-*`), `context.ts` (what the root inherits and sits on, from ancestors the clone
  does not contain) and `wellFormed.ts` (XML the SVG decoder will accept).
  `source.report()` counts what it had to give up on. Still out of scope: iframes, closed shadow roots, WebGL without
  `preserveDrawingBuffer`.
- `demo/hostile/` — one specimen per case that degrades silently. The acid test for the above.
- `core/styles.ts` — `roundtrip.css` as a string, injected once per document as
  `<style data-rt>`. There is no CSS file to import: a `.css` import is a build-tool contract
  the consumer has to honour, and an injected `<script>` cannot bring one at all.
- `codecs.ts` — codec families, the candidate strings each expands to (level derived from the
  coded area), and the per-family starting dials. Pure, unit-tested.
- `codec/probe.ts` — runtime codec selection, sweeping the families `codecs.ts` orders.
- `codec/pipeline.ts` — encoder + mosh filter + decoder as one unit, because the decoder's
  priming invariant is a property of the pair.
- `mosh.ts`, `frameBudget.ts`, `quantizer.ts` — pure, unit-tested.

### Package shape
`npm run build:lib` → `roundtrip/dist`, `npm run pack` → a tarball beside it. Order inside
`build:lib` is load-bearing: ESM first (`vite.config.ts`, `emptyOutDir: true`), then the IIFE
(`vite.iife.config.ts`, `emptyOutDir: false` — IIFE is single-entry and cannot share the
multi-entry build), then `tsc -p tsconfig.build.json` for declarations, then
`scripts/dts-extensions.mjs`. Run tsc first and Vite deletes the declarations.

- `dist/index.js` — React surface. `dist/core.js` — framework-free; `index.js` imports it, so
  nothing is duplicated and `core.js` contains no React at all (the build greps for it).
- `dist/roundtrip.iife.js` — self-contained, global `RoundTripCore`. This is the paste-into-a
  -third-party-page artifact.
- `exports` stays on `src`; `distExports` (top level, not `publishConfig`: npm 11 warns that
  it is an unknown config there) holds the dist map and
  `scripts/pack-exports.mjs` swaps it in from `prepack` (see the gotcha — npm does not do this
  itself). `files: ["dist"]`, react/react-dom peers `^18.3.1 || ^19`, both optional.

## Gotchas (each empirically bit prior work here)

- **DATA URI, NEVER BLOB URL, for the serialized SVG.** All browsers treat SVG-as-image
  containing `<foreignObject>` as origin-clean from a `data:` URI; blob URLs still taint in
  Chromium and WebKit. A tainted canvas makes `new VideoFrame(canvas)` throw `SecurityError`,
  which kills the pipeline outright. This one line is what makes the permissionless path viable.
- **The inlined font CSS MUST be cached across frames.** Building it costs 229ms and 384KB for
  six faces; cached it costs ~5ms/frame. Rebuilding per frame is what made `modern-screenshot`
  look like it was hanging — it refetches the fonts every call.
- **Fonts fail SILENTLY inside `foreignObject`.** An `<img>`-loaded SVG is a separate document
  and cannot see the host page's fonts. Without inlining, the demo heading renders in Georgia
  instead of Fraunces, 32.9% of its pixels differ, and the text reflows. It does not error — it
  just quietly renders the wrong thing, which reads as a broken website rather than as a codec
  artifact, destroying the point of the piece. Always eyeball the type after touching capture.
- **Do NOT pin `hardwareAcceleration: 'prefer-hardware'`.** On this machine it silently
  eliminates VP9 and AV1 — both are software-only here and `isConfigSupported` just returns
  false with no reason. `probe.ts` sweeps the acceleration dimension instead. The pin buys
  nothing: measured at 864x544, avc1 4.1ms/frame, vp09 4.2, av01 5.2 — all realtime.
- **`coarseness` is normalized 0–1, NOT a raw QP.** At the same nominal quantizer AV1 produced
  815 bytes/frame against AVC's 2084 — it artifacts far less — and AVC's QP range is 0–51 while
  VP9/AV1 are 0–63. `quantizer.ts` maps the dial per codec. That table is **calibrated by eye**;
  if switching codecs changes the look at a fixed coarseness, the table is what to fix — on
  `/compare/`. For av1/vp9 the dial is a bitrate and a GOP, not a quantizer; see below.
- **`VideoFrame` is refcounted native memory, not garbage.** Every frame — encoder input and
  decoder output — is closed in a `finally`. One owner per frame. A leak stalls the encoder and
  then the whole pipeline, with no error.
- **Fresh object identity in state will silently kill the pipeline.** `setSize` returning a new
  `{w,h}` on every ResizeObserver callback re-ran the main effect, tearing down and rebuilding
  the encoder faster than it could ever paint a frame. Canvas stayed black; `tsc` and
  `vite build` both passed. Same family as any state selector that returns a fresh `[]` on every call. ALWAYS
  browser-test UI changes.
- **CSS ANIMATIONS DO NOT ADVANCE IN A HIDDEN TAB EITHER.** Every `Animation.currentTime` on
  this headless box reads 0, forever, so "the capture is frozen" proves nothing here. Seek them
  instead: a single `animation-delay: var(--seek, 0s)` on the rule, driven by
  `document.documentElement.style.setProperty('--seek', '-137s')`, moves every animation in the
  list to a known point in its own cycle (a one-value delay list repeats across the shorthand).
  Both the hostile specimens and the KCUF splash page (kcuf.biz) carry that hook for exactly this reason.
- **VERIFYING IN A BACKGROUNDED TAB WILL MISLEAD YOU.** Capture is driven by
  `requestAnimationFrame`, which Chrome suspends entirely when `document.visibilityState` is
  `'hidden'` — so the canvas stays black and there is no error to find. That pause is CORRECT
  behaviour (don't encode an invisible page); do not "fix" it. Check `document.visibilityState`
  first, and drive `pipeline.push()` manually from the console to test the pipeline itself.
- **`captureMode: 'on-interaction'` was verified by the author at a real screen** (#74, 2026-09-27):
  `/hostile/?mode=on-interaction` shows `painted / s` falling to 0 when idle and returning to
  ~20 on movement. It still cannot be exercised on this box: a hidden tab clamps timers to
  ~1s (and after ~5 minutes hidden, far worse), so a setTimeout-driven rAF shim paints about
  once a second and every idle/awake measurement comes out wrong. Ask your human to check it at a real screen.
- **Scroll position is a PROPERTY, so cloneNode() drops it.** Same class as form state: a
  scrolled container captures as though scrolled to the top unless you reproduce it. The clone
  renders in a separate document where `scrollTop` means nothing, so `syncScrollState` clips
  the scroller and transforms its children instead. **Do not "simplify" this by wrapping the
  children in one translated div** — if the scroller is a flex or grid container the wrapper
  becomes its only item and the layout collapses. Transforming each child shifts them all
  identically, which is what scrolling looks like, and transforms are paint-only so neither
  layout nor selector matching moves. Verified in-browser: a capture at scrollTop 300 matches
  the unscrolled capture shifted by 300px at **100%**, against 27.6% unshifted. Not unit-tested
  on purpose — jsdom reports scrollTop as 0, so a passing test there would prove nothing.
- **`position: fixed` is the trickiest thing in the capture path.** A transformed element
  becomes the containing block for its fixed descendants, so shifting the scroller's children
  silently re-anchors every fixed element below them. **Compensating with an equal-and-opposite
  translate is the obvious repair and it is wrong** — it works for `top`-anchored elements
  (a fixed header went 17% -> 100% identical across a 400px scroll, which is exactly what makes
  it look correct) but a `bottom`-anchored element re-anchors to the bottom of the whole 300vh
  page and renders outside the frame entirely. The anchor changed, not the offset. So
  `syncScrollState` converts fixed to absolute against whatever the clone's containing block
  will actually be, using live measurements: offsets taken relative to that block already
  account for the scroll, because the block is shifted by the same amount.
- **Measuring a transparent element by region diff will lie to you.** Bare text over a
  scrolling gradient shows a low region match no matter how correctly it is placed, because
  most of the region is moving background. Compare glyph pixel-count and centroid instead:
  "Test" reads 1324/1313/1312 px at centroid (86,77) across three scroll positions, which is
  what proves it held still.
- **The component owns the scroll container.** Give `.rt-root` a bounded height and
  `.rt-content` scrolls inside it while the canvas, pinned to the root, stays put. With an
  unbounded root it resolves to auto and is inert. Scrolling is the strongest motion the piece
  gets — it moves the whole frame at once — so it pairs hardest with moshing.
- **Anything rendered alongside the stage must live OUTSIDE `.rt-content`.** Everything in that
  subtree is captured and round-tripped, so a control panel inside it gets encoded into the
  very artifacts it exists to adjust. The demo's overlay is a sibling for exactly this reason.
- **CSS ANIMATIONS ARE SNAPSHOTTED, NOT REPLAYED — and the snapshot is of RESOLVED values.**
  An `<img>`-loaded SVG gets a fresh animation timeline on every load and capture builds a new
  `Image` per frame, so the clone's own clock is always t=0 and nothing can move it. (History:
  before `capture/animations.ts` existed, two captures 650ms apart differed by 58.4% of pixels
  for a JS-driven gradient and **0.0%** for the same motion as CSS keyframes — perfect in the
  live DOM, which nobody sees, frozen in the video, which is all anyone sees.) So
  `animations.ts` writes the CURRENT computed values onto the clone as inline style instead,
  in two passes, and `prepareClone` runs it BEFORE positioning — positioning writes a composed
  `translate(scroll) <computed transform>`, so freezing second would overwrite that and
  silently drop the scroll offset of every animated element.
  - `snapshotInheritedCustomProperties` — every `--*` in `getComputedStyle(source)`, set
    inline on the clone root. **Snapshot resolved values, NOT the animated inputs.** var()
    substitution happens at computed-value time on `:root`, so a descendant consuming
    `var(--field)` never sees `--g-angle` at all; it inherits the already-resolved gradient.
    Measured on the KCUF splash page (thirteen `@property` animations on `:root` feeding one
    `--field`): setting only the inputs changes the frame by **0.00/255**, setting all the
    resolved properties changes it by **44.84/255**. Through the IIFE on that page, two grabs
    at two animation times now differ by **74.57/255** (control, same time: 0.00). Costs
    0.200ms median / 0.500ms p95 against a 27.8ms grab.
  - `freezeAnimations` — for animations and transitions whose target is INSIDE the subtree:
    one `document.getAnimations()` grouped by `effect.target` (never `el.getAnimations()` per
    element), each `KeyframeEffect`'s property names off `getKeyframes()`, each one's computed
    value written inline, then `animation: none; transition: none`. That last part is
    load-bearing — a running animation beats inline style in the cascade, so without it the
    clone's restarted timeline puts the t=0 value straight back on top.
    **`getKeyframes()` omits custom properties from a CSS animation's keyframes**, so the ones
    its `@keyframes` rule declares are pinned too (see the `getKeyframes()` entry below). Specimen
    `/hostile/#css-prop` (`inherits: false`, inside the subtree): frozen without it (0 change
    across a 9s seek, 65.6 live), turning with it.
  - An animation on an ancestor ABOVE the captured subtree that animates a non-custom
    inheritable property (`color`, `font-size`) used to be the open gap here; `context.ts` now
    reads the parent's computed inherited set every frame, which covers it. Still skipped: effects that are not
    `KeyframeEffect`, and effects targeting a pseudo-element (nowhere to write inline style).
    And a canvas is still pixels, not computed style.
  - Specimens: `demo/src/hostile.tsx` `#css-anim` (keyframes on transform+color) and
    `#css-field` (`:root` `@property` gradient read through `var(--field)`), both seeked by
    `--seek` on `<html>` — **outside** the captured subtree, which is the point:
    `cloneNode()` cannot carry it. Verified in-browser by disabling the passes: with neither,
    both specimens read **0.00** mean diff across a `--seek` change; with pass 2 only, the
    animated word moves (5.44 over its box, glyph centroid 55 -> 163 px, count 794/783) and
    the gradient stays 0.00; with pass 1 only, the gradient moves (60.41); with both, both
    move. One honest caveat on that table: pass 1 alone ALSO moves the word, because `--seek`
    is itself a custom property, so the clone inherits it and the SVG's own restarted timeline
    happens to seek to the same place. That is an artefact of how the specimen is driven, not
    a general property — a page whose animations run on wall-clock time gets nothing from
    pass 1 — which is why pass 2 is tested with pass 1 OFF. `demo/src/content/Drift.tsx`
    stays JS-driven anyway; see its header.
- **ONE ILL-FORMED NODE LOSES THE WHOLE FRAME** (#62). The clone is HTML, serialized by an
  XMLSerializer that validates nothing, decoded by an XML parser that recovers from nothing.
  Checked in Chrome 150, each of these alone gives "The source image cannot be decoded." and a
  black canvas: `--` inside a comment, Alpine's `@click` / `:class`, any `x-on:click`-style
  prefixed name (undeclared namespace), a C0 control char in text. `wellFormed.ts` strips them
  after every pass; on a decode failure `explainUndecodable` reparses with DOMParser and puts
  the parser's line/column/snippet in the error. The CSS goes into CDATA, so `]]>` is split too.
- **Never absolutise `url(#id)`** (#63). It points into the image document, which is where the
  cloned `<linearGradient>` lives; resolved, it points at another document and SVG paints the
  failed server as `none`, silently (kcuf's wordmark: 0% ink). `SELF_CONTAINED` in
  `cssResources.ts` covers both rewrite passes. `report.brokenReferences` counts fragment refs
  on SVG elements whose target is outside the capture — SVG elements only, because a
  getComputedStyle sweep of every HTML element costs ~10ms per thousand.
- **The clone has no ancestors, so it inherits nothing and sits on nothing** (#67). Not a body
  quirk: any subtree loses `color`, the font and the rest of the inherited set, and the
  marketing page came back black Times while `missingFonts: 0` — true, and pointing away from
  the cause. `context.ts` wraps the clone in a stand-in for its parent carrying the parent's
  computed inherited properties. Three traps, each measured:
  - **`line-height` resolves to px in getComputedStyle** (`1.5` at 20px reads `30px`), and a
    px value inherited by a 48px heading overlaps its lines. A probe span with `font-size:100px`
    appended to the parent (our own `.rt-root` in both entry points) says whether it scaled.
    Memoised on the parent's line-height/font-size/colour scheme.
  - **`-webkit-text-fill-color` defaults to currentcolor, reported RESOLVED.** Carried blindly it
    pins every `<input>` (UA colour fieldtext, not inherited) to the page's body colour — pale
    text on a white field. Carried only when it differs from `color`.
  - **`html { font-size }` matches nothing in the image document**, so every `rem` resolved
    against 16px. (`:root` rules DO match the `<svg>`, which is how this hid.) The svg root gets
    the live html font-size.
- **The ground: html/body propagate to the viewport, and only one of them does.** html's
  background if it has one, body's otherwise; body with html painting is just an element with a
  box. The first cut always took html's and captured kcuf's body-borne field as flat maroon.
  `context.ts` carries the nearest painting ancestor WHOLE when it propagates or its box is the
  capture's box (the body mount), else its colour only and `ancestorBackgroundImages++`. Under
  everything, the scratch canvas is filled with the page's resolved `Canvas` colour instead of
  black. `mount.ts` no longer copies html/body's colour onto the live `.rt-content`: that also
  covered body's background image in the LIVE page (the reduced-motion view).
- **`:hover` / `:active` / `:focus` are UA state, and an image has none** (#68). Stamped onto the
  clone as `data-rt-hover` etc. and rewritten in the CSS text once per cache build.
  `rewriteStateRules` rewrites selector PRELUDES only — a plain regex also rewrites
  `@media (hover:hover)`. The `rt-` prefix keeps clear of the site's own `data-hover`. The UA
  focus ring is restated for `[data-rt-focus-visible]` ahead of the page's CSS. In a hidden tab
  `:hover` is still drivable through CDP mouse events (Puppeteer's or Playwright's `hover`, for example);
  `:focus` may not match until the window has focus even though `:focus-within` does.
- **A blocked-image placeholder must take the source's `display`.** It was always
  `inline-block`, which sits on the baseline and gains the strut's descent: every figure holding
  a blocked `display:block` image grew ~6px and the whole grid below captured low on /hostile/.
- **The clone paints an overlay scrollbar the live page is hiding.** macOS overlay thumbs are
  invisible at rest, but the clone is a fresh scroller and paints one every frame, light or dark
  by the scroller's background. `scrollbar-width: none` on the clone only when the live
  scrollbar takes no space; a classic one is real and hiding it would widen the layout.
- **`status: 'running'` means the first frame has been PAINTED**, not that the pipeline was
  built. The canvas is visible from 'running' on, so the old timing showed a black overlay for
  the first capture's duration, and a black canvas reading 'running' is what sent #62's debugger
  towards the codec. Every rebuild (resize) goes back to 'idle' until its own first paint.
- **`declaredFramerate` does nothing in quantizer mode** (avc/hevc's default). Measured at
  864x544: AVC 2421 vs 2422 bytes/frame at 5 vs 60fps, AV1 byte-identical; under `variable` it
  is a big lever (16057 vs 2838). Since #70 it says so: an explicitly set value on a quantizer
  stream logs ONE `console.warn` per page (`framerate.ts`), and `tune({ declaredFramerate })`
  applies it live in bitrate modes through the same rate-limited reconfigure as the av1/vp9
  bitrate retarget (one forced keyframe), and never reconfigures a quantizer encoder for it.
  `<RoundTrip>` no longer defaults it to 60 itself — undefined is how the core tells "unset"
  from "set" — and still rebuilds on change rather than tuning.
- **The encode frame is even; the content rect is not** (#75). `encodeSize()` rounds up to even
  for 4:2:0, so an odd display size leaves a pad row/column past the content. The canvas used
  to take the ENCODE size as its backing store, and stretching 842 rows into an 841px box put
  the pad on the last CSS pixel as a dark line (kcuf: last row [0,3,37]; iOS: a line above
  the toolbar). Now `contentSize()` is the rect the content occupies: capture renders into it,
  repeats its edge into the pad so the encoder has no colour step to ring on, and the canvas
  backing store is that rect with only it drawn. Verified 400x301, 401x301 and a body mount at an
  813px viewport: backing equals the CSS box, last row clean. Anything that composites decoded
  frames must crop to `contentSize()`, never draw the whole frame.
- **`encodeScale` used to CROP, then to RE-LAYOUT; it now just scales.** The SVG is the clone's
  whole viewport, so it must be the element's LIVE size: `vw`, `vh` and every `@media` query in
  the page resolve against it. First it was the encode size with no `viewBox` (at 0.5 the frame
  held the page's top-left quarter at 1:1). Then it was the content rect with a `viewBox` to
  the live box, which scaled correctly but laid the page out for the smaller viewport: at 0.5
  on a 1440px window the marketing page crossed its 760px breakpoint and captured its PHONE
  layout over the desktop DOM (the author, 2026-10-02). Now the svg is `liveW x liveH` and
  `drawImage(img, 0, 0, liveW, liveH, 0, 0, cw, ch)` does the scaling. Verified on the
  marketing page at 0.5 and 0.25, desktop and phone: aligned with the live page.
  Specimen `/hostile/?scale=0.5#vw` (breakpoint 1000px, so any 1000–1999px window crosses it):
  with the old svg sizing its 15vw bar captured red and 54px wide against 108px cyan live.
- **`Document.getAnimations()` does NOT include animations inside shadow roots** (#74). The
  code once said it did; the shadow-root specimen froze in the video while moving live (6
  animations on /hostile/, 0 in shadow trees, while the bar reported 2). `runPasses` folds in
  `shadowRoot.getAnimations()` for each open root it meets, before flattening recurses into it.
- **Shadow flattening must PAIR before it removes the clone's `<style>`s.** The live root still
  has them, so removing first shifted every shadow pair by one and each pass styled the element
  before the one it meant to, in every root that opens with a `<style>`. Found by the same
  specimen; `/hostile/`'s slot specimen still passes with the fix (checked by the author).
- **av1/vp9: coarseness is a starved CONSTANT BITRATE plus a keyframe rhythm, not a quantizer**
  (#72). Chrome's quantizer mode cannot make them heavy: q2 -> q63 at 344x360 took av1 3885 ->
  1196 bytes/frame and vp9 2978 -> 1324, against avc 2730 -> 184, and at q63 both came back
  nearly clean. Under a constant bitrate the same encoders reach 258/299 bytes/frame at 20kbps
  with every frame emitted. `RATE_CONTROL` in quantizer.ts picks the mode, the probe ranks it
  first for them, `bitrateFor` maps the dial geometrically, and the pipeline retargets live (at
  most every 250ms, since a reconfigure forces a keyframe). Two things that are not obvious:
  - **A starved stream HEALS between keyframes.** Each delta spends its budget refining the
    decoder's picture toward the source, and on a static page nothing competes, so av1 went
    from error 11.2 at a key back to 6.6 within ~7 frames. Damage on a static page comes from
    how often it is re-broken, which is why `resolveDials` derives an unset av1/vp9 GOP from
    coarseness (`gopFor`: none below 0.15, ~15 at 0.5, ~5 at 0.78, 2 at 1.0).
  - **Keyframes have a floor (~2.1KB at 344x360, the same at 8kbps and 20kbps).** At a fixed
    GOP 3 the keys alone cost ~115kbps, more than the bitrate asked anywhere above ~0.3, so
    the dial did nothing past there; that is what made the GOP part of the dial.
  The author by eye (Mac Chrome, /compare/): matches avc at 0.78; the shape is "roughly right", may
  want tweaking; accepted that av1 still reads lighter than avc at 1.0.
- **The probe is FAMILY-first, then each family's own mode order** (#91). It used to rank by
  mode ("every family's first mode, then every family's second"), so a machine whose AVC had
  CBR but no per-frame QP got AV1. That machine is any software-only AVC encoder — measured in
  headless Chrome on this box: `avc1.64001f` quantizer false in every acceleration, constant
  true; av01 true in both. The family decides the look and the mode is calibration, so AVC in
  constant now beats AV1 in anything. The pipeline turns coarseness into a bitrate for ANY
  constant-mode stream, not just RATE_CONTROL 'constant' families, or that AVC sat at a flat
  200kbps (measured after the fix: 2080 / 376 / 265 bytes/frame at 0.1 / 0.5 / 0.9). The look
  of AVC-under-CBR has not been judged by eye; `bitrateFor` was fitted for av1/vp9.
- **`/compare/` is where the per-codec tables are judged.** All four families side by side at
  one coarseness, mosh off, avc/hevc floors live-editable and mirrored into the URL. HEVC's
  floor went 20 -> 10 there by the author's eye; avc stays 18.
- **CSS motion path survives capture; SMIL would not.** The logo's arrowheads ride
  `offset-path` with `offset-distance` animated, and the capture's freeze pass pins
  `offset-distance` like any other property — verified: the arrows sit in the same place in the
  captured frame as in the live DOM. A captured frame is a fresh SVG document with its own
  clock at zero, and `document.getAnimations()` does not see SMIL, so `<animateMotion>` would
  freeze at t=0.
- **Read the stage through `stats()`, never through its canvas** (#79). The marketing page's
  readout wrapped `drawImage` on the overlay canvas for paint rate and read the canvas size for
  the encode size, and #75 silently changed what that size meant. `stats()` (controller and
  mount handle) reports status, codec, encode and content sizes, the pipeline's own counters
  and a paint rate measured by `createRateMeter` — trailing one-second window, so it decays to
  0 when painting stops instead of freezing at its last value. Counters are per build. On
  `<RoundTrip>` it is a ref (`forwardRef`, `RoundTripHandle` = `{ stats, report }`, #80):
  the handle is stable and reads the CURRENT controller at call time, because every rebuild
  replaces the controller — an `onController` prop would hand out one that goes disposed. No
  `tune()` on it: the dial props already tune, and it would be overwritten by the next one.
- **`getKeyframes()` reports NO custom properties for a CSS animation**, registered or not,
  alone or beside ordinary properties (`{ --r, transform }` reports `transform` only; Chrome
  151). A CSSTransition of `--r` and an `element.animate()` of it DO report it. So pass 2 used to
  freeze them at their initial value on any element inside the subtree (pass 1 only covers ones
  inherited from above): the marketing page's rainbow `--sway` had never moved in the video, and
  its background stops read 0.00 diff across a 40s seek against 9.73 live. The first fix pinned
  EVERY custom property on an animated element; #97 measured that at +2–3ms/frame and +8.5KB on
  the marketing page (325 properties over 18 elements, nearly all inherited design tokens). Now
  `createKeyframeCustomsLookup` reads the names off the animation's own `@keyframes` rule
  (`CSSKeyframeRule.style` does enumerate them), per tree scope, once per capture, and pins only
  those; pin-all survives as the fallback when the rule cannot be read (cross-origin sheet).
  Pixel-identical to pin-all on the marketing page at three animation times. (The measurement
  harness is kept out of the repo.) **Diffing against the parent's value
  was considered and rejected**: an animated value that happens to equal its parent's (a hold
  keyframe, a loop boundary) would be skipped and the clone would show the element's declared
  value instead.
- **A `background` SHORTHAND holding `var()` vanishes from the rule's `cssText`** when a
  longhand of it (`background-color`) follows in the same rule. The live page renders it; capture
  copies rules by `cssText`, so the clone gets no gradient and nothing errors. Write the
  longhand (`background-image`). Capture now detects it and falls back to the sheet's authored
  text (#87, `lostDeclarations` in `cssResources.ts`).
- **Apple's hardware AVC answers a starved bitrate by SKIPPING FRAMES, not by degrading them.**
  #91 (family-first probe) plus coarseness-as-bitrate for ANY constant-mode stream put a device
  with no AVC quantizer mode (the author's iPhone; Safari generally) on AVC at ~50kbps at phone size: one
  painted frame every 2-3 seconds. Measured on the Mac's VideoToolbox at 394x852, 60 real page
  frames: 50kbps -> 2 out, 150k -> 15, 400k -> 60; once flowing it will not go below ~1.5KB/frame
  (vs 939 bytes on the quantizer path), so starving it never makes it uglier, only slower.
  Software AVC emitted every frame at every rate (what #91 was measured against). Fixed
  2026-10-09, the author's choice of the safer route:
  - coarseness is a bitrate for AV1/VP9 only again; AVC/HEVC in a bitrate mode run at a flat
    200kbps, which is what played smoothly on the iPhone before #91;
  - the probe is LOOK FIRST by default (each family in its own best mode, `avc -> hevc -> vp9 ->
    av1`, then the other modes), so that iPhone gets VP9: first paint ~0.4s, ~24fps, crunchy;
  - `preferMoshable` (core, React, mount) makes it family-first again, AVC in any mode; the
    site turns it on with Enable Mosh and only rebuilds when the encoder would change (on a
    quantizer device mosh stays a live toggle);
  - `starvation.ts` stays as a safety net: frames in vs chunks out per 400ms, doubling the
    bitrate while under half come back (ceiling x32), on unpinned bitrate-mode streams; it looks
    BEFORE backpressure and counts backpressure drops as frames in, since a starving encoder
    fills its queue and nothing after that ever reached the guard.
  Tried and dropped: rebuilding a starving AVC at half size (compressed enough, but in constant
  mode VideoToolbox held a fresh session's first output 2-3s in the stage at every rate up to
  3.2Mbps; not reproduced in isolation, cause not found).
- **iOS Safari draws a large image nested in an SVG-as-image BLANK until a background decode
  finishes, so a per-frame `<video>` snapshot vanished from most captured frames** (2026-10-12,
  the author's iPhone). Embedded, each frame is a new PNG data: URI, so its decode is almost never done
  in time: the stage showed the clip for a frame or two, then lost it. Measured with a 240px SVG
  holding one fresh frame and nothing else: kept 100% at 64, 128 and 256px square, 0-25% at 384
  and 540px. Ruled out first, one at a time, each kept 100%: SVG size, the page's markup, a 290KB
  font stylesheet, `onload` vs `decode()`, the live stage running alongside, and the `<video>`
  attributes copied onto the `<img>`. Decoding the same URI as a standalone Image first did not
  help. Chrome keeps every size. So a plain-box video is now COMPOSITED: left as an empty box in
  the SVG and drawn onto the scratch canvas afterwards (`VideoOverlay` in
  `replaceUnserializable.ts`), which also skips its toDataURL (2.6ms at 540px, 6.5ms at 1080px
  on the M4). It is drawn on top of everything, so a video that is transformed, faded, filtered,
  masked, rounded, not `object-fit` fill/contain/cover centred, or overlapped by a fixed/sticky
  element (a nav it scrolls under) or by any element LATER in the document (a title set over a
  hero video; `laterOverlaps`, 2026-10-18) is still embedded, so the frame keeps the page's
  stacking. On WebKit that embedded frame is held to
  256x256 worth of pixels (`embedSize`, `WEBKIT_EMBED_BUDGET`; every browser caps it to the
  video's box), which is what stopped the flicker under the nav (2026-10-16); Chrome keeps it
  sharp. `compositeVideo: false` on the source restores the old path for comparison. **A large
  `<canvas>` that changes every frame has the same problem and is NOT fixed** (still embedded);
  see #110. `/video/` is the test page.
- **Read a rule's declarations with `style.item(i)`, never `style[i]`.** An `@position-try`
  rule's `style` is a `CSSPositionTryDescriptors`, which in Chrome has a `length` but no indexed
  getter: `style[0]` is `undefined`. `lostDeclarations` indexed it and threw on every frame of
  GitHub's issue pages (primer-react ships a dozen `@position-try` rules), surfacing only as
  "Cannot read properties of undefined (reading 'startsWith')" in the status line. Computed
  styles (`getComputedStyle`) index fine.
- **A flat black ground destroys a motion specimen.** The encoder allocates almost no bits to
  it, so a thin bright object moving over it is crushed to disconnected blocks (verified
  illegible at q60), and smear against black is invisible regardless — which loses the artifact
  you were trying to show. The motion field uses a saturated MID-TONE for exactly this reason.
  Function beats pacing instinct here.
- **Every encoder reconfigure forces a keyframe**, which resets the accumulated error the piece
  is made of. The ResizeObserver is debounced 150ms for that reason.
- **The decoder errors if its FIRST chunk is a delta.** `mosh.ts` always passes the priming
  keyframe regardless of config. That invariant is asserted first and hardest in its tests.
- **Priming belongs to the DECODER, not to the mosh filter.** Every prop change swaps the
  filter; a fresh filter starts unprimed and drops every chunk until it sees a keyframe, and
  under `gop: 'infinite'` there is never another one — so the picture froze permanently and
  read as a crash. `createMoshFilter` takes an `alreadyPrimed` argument and `tune()` carries
  `filter.primed` across the swap. Related: `tune()` compares the mosh config BY VALUE, because
  a React caller hands over a fresh object every render and rebuilding on identity would also
  restart the PRNG.
- **Never bake a live-tunable value into a long-lived closure.** `captureFps` was read once
  when the pacer was built inside the capture loop, so dragging it did nothing until some other
  prop forced a full rebuild — which is why it looked like "only declaredFramerate applies".
  `Pacer.due(now, fps)` takes the rate per call now. Anything tunable is read from
  `dials.current` at use time.
- **THE DECODER IS EXPECTED TO DIE UNDER MOSHING, AND MUST BE ABLE TO COME BACK.** A keyframe
  resets the reference-frame buffers, so dropping one — the entire point of moshing — leaves
  every following delta referencing state the decoder never got. A conformant decoder answers
  with "Decoding error", and **a VideoDecoder that errors is CLOSED**: every later `decode()`
  throws, so the picture stops forever after a single good frame. That is the piece working,
  not failing; the bug was having no way back. `pipeline.ts` now rebuilds the decoder, sets
  `needKeyframe` so the encoder emits one, and lets that keyframe past the mosh filter via
  `awaitingRecoveryKey`. Deltas are held while waiting, since they are useless without a
  reference. `stats.decoderResets` counts it. Never surface a decoder error to `onError` here.
  The visible result — bloom, collapse, snap to clean, bloom again — IS what datamoshing looks
  like; the recovery is the aesthetic, not a patch over it.
- **Keyframes do NOT reset a closed-loop encoder; only a DROPPED keyframe accumulates, and on
  AVC/HEVC it never recovers on its own.** Measured on AVC at coarseness 0.78, error against
  the source: without mosh, the keyframe at frame 20 changes nothing visible (3.8 -> 4.2 ->
  3.7 across it) and `gop: 'infinite'` sits flat at ~4 for 36 frames. The encoder is
  CLOSED-LOOP — every P-frame is coded against the reconstruction the decoder will have, so
  it keeps correcting toward the source and there is no accumulated error for a keyframe to
  reset. "More keyframes" is therefore not a dial on the look at all. With mosh dropping every
  key, the same run goes 3.8 -> 18 at the dropped key and climbs to 24 with NO recovery,
  because VideoToolbox's AVC/HEVC decoder never actually dies — it keeps decoding deltas
  against a stale reference forever, so `pipeline.ts`'s recovery keyframe (which is what snaps
  AV1/VP9 back, since THEIR decoders do die) never fires. Net effect the author saw on the panel:
  "GOP 20" looked exactly like "no keyframes". `keepEveryNthKeyframe` is the fix — let every
  Nth eligible keyframe through so the bloom snaps back on a rhythm — and AVC/HEVC default to
  3 for that reason.

- **`mosh` needs a finite GOP to do anything.** It drops keyframes, so with `gop: 'infinite'`
  there are none after the first and it is a no-op (`dropDeltaChance` still bites). The demo
  panel warns when that combination is selected.
- **Chrome's AVC encoder enforces the LEVEL and refuses ODD DIMENSIONS. HEVC does neither.**
  Measured 2026-09-19, Chrome 150/macOS, `isConfigSupported`: at 1440x900 `avc1.42001f`
  (Baseline 3.1, 921,600px cap) is **false** while `avc1.640028` and `avc1.42002a` are true —
  and the DECODER accepts all three, so the asymmetry is encoder-side only. At 606x713 both
  `avc1` strings are false and `hev1.1.6.L93.B0` is true; at 606x714 all three are true.
  `avc1.42001f` was the only AVC string the probe ever offered, which is why AVC — the one
  family that moshes into the classic look — could never win on a laptop and the piece was
  effectively AV1-only. `codecs.ts` derives the level from the coded area; the pipeline always
  goes through `encodeSize()`, which rounds to even. Anything that probes OUTSIDE the pipeline
  must round too, or it reports a codec the stage would never get (DeviceInfo did).
- **HEVC's quantizer goes in the `hevc` slot, not `avc`.** In the `avc` slot Chrome ignores it
  without erroring: 864x544, 14 frames, q20 and q45 both 7450 bytes/frame and only 2 of 14
  frames ever emitted, against 2876/499 bytes and all 14 with `hevc`. The dial did nothing at
  all on HEVC. Harmless while HEVC was last in the probe order; not harmless now it is second.
- **A MessageChannel yield advances NO wall-clock time, so the encoder never drains.** It is
  the right tool for stepping a hidden tab's microtask/task queue (unlike `setTimeout`, which
  Chrome clamps to ~1s when hidden) but 80 of them cost microseconds, and a hand-driven
  pipeline reported `encoded: 0, dropped: 3` — pure backpressure, no error, looking exactly
  like a broken pipeline. The encoder needs real time. Use the clamped `setTimeout(0)`: one
  second is plenty, and it is the throttling that makes it useful here.
- **`rewriteRelativeImportExtensions` rewrites the JAVASCRIPT ONLY, never the `.d.ts`.**
  Verified against tsc 5.9.3 with a two-file repro: emitted `.js` says `from "./a.js"`, emitted
  `.d.ts` still says `from './a.ts'`. Vite emits our JS, so declarations are the only thing tsc
  produces for us — i.e. this package sits entirely inside the flag's blind spot, and a
  consumer would be pointed at `./types.ts`, which is not in the tarball.
  `roundtrip/scripts/dts-extensions.mjs` finishes the job. Only RELATIVE specifiers: a bare one
  ending in `.ts` is a package name.
- **npm does NOT apply `publishConfig.exports` when packing.** Verified by unpacking the
  tarball: `exports` still pointed at `./src/index.ts`, which `files: ["dist"]` excludes, so
  the package resolved to nothing. npm only overrides a fixed set of fields.
  `scripts/pack-exports.mjs` does the swap in `prepack` and undoes it in `postpack`, saving the
  original to `package.json.packbak` so an interrupted pack leaves something to restore from
  rather than a guess. The dist map is a top-level `distExports` (it was `publishConfig.exports`
  until npm 11 warned that unknown publishConfig keys stop working in its next major). npm shows
  the package folder's README and reads it BEFORE prepack (0.1.0's page had none), so
  `roundtrip/README.md` is a committed copy of the repo's; `apply` refuses to pack if they
  differ (`cp README.md roundtrip/`). And `prepublishOnly` runs `build:lib`, so `npm publish` from
  `roundtrip/` never ships a stale `dist`.
- **`types.ts` must stay REACT-FREE.** `./core` is the framework-free entry and re-exports
  types from there, so one `React.ReactNode` in that file makes `@types/react` a hard
  requirement for a consumer who has no React — it surfaced as two "Cannot find namespace
  'React'" errors when typechecking the packed tarball from a bare project. `RoundTripProps`
  therefore lives in `RoundTrip.tsx` next to the component.
- **Vite's `root` is the process CWD, not the config file's directory.** `vite build -c
  roundtrip/vite.config.ts` from the repo root resolves `src/index.ts` against the repo root
  and dies with "Could not resolve entry module". Both lib configs set `root` from
  `import.meta.url` (not `node:url`, which would drag `@types/node` into a workspace whose
  `types` is scoped to `@types/dom-webcodecs`).
- **An index-matched source/clone walk must capture its arrays BEFORE anything mutates the
  clone.** `syncFormState` and `syncScrollState` each used to re-query both trees and trust
  the i-th element of one to be the i-th of the other. That holds only until a pass inserts a
  sticky spacer, swaps a `<canvas>` for an `<img>` or flattens a shadow root — after which
  every later pass styles the wrong element, silently. `capture/pairs.ts` builds the pairing
  once and every pass takes it. Order is load-bearing too: form -> positioning -> replacement
  -> shadow, because replacement copies the inline style positioning wrote, and shadow is the
  only pass that adds nodes with no source counterpart.
- **Anchoring a fixed/sticky element needs its BOX, not just its corner.** Converting to
  `position: absolute` with `left`/`top` and no width lets it shrink-to-fit, and an element
  that got its width from being a block in flow has nothing to fall back on. Measured: the
  hostile page's full-bleed sticky bar collapsed from 1920px to 479px — right place, wrong
  shape. It hid on the demo page because every fixed thing there is inline-block, but it was
  wrong there too: the h1's cyan ground captured 6225px short until the box was pinned, and
  is now exactly 91px tall, matching the live DOM. Pin `width`/`height` from the measured
  rect with `box-sizing: border-box` (getBoundingClientRect reports the border box).
- **`position: sticky` is IN FLOW, so the fixed treatment alone is not enough.** Pull it out
  to absolute and its siblings close the gap — everything below jumps up by its height, which
  reads as a broken layout rather than as a codec artifact. It needs an in-flow spacer of the
  same box. Verified: a capture at scrollTop 400 matches the unscrolled capture shifted by
  **exactly 400px at 100.0%** (444px — the spacer missing — scores 94.0%, 356px scores 87.0%).
  Only convert when the scroller is actually scrolled; at offset 0 sticky is already in the
  right place and taking it out of flow can only add error.
- **`assignedNodes()` must be asked of the LIVE `<slot>`, never a cloned one.** Slot assignment
  is a property of being in a shadow tree, so a cloned `<slot>` in a DocumentFragment is just
  an unknown element and `assignedNodes()` returns `[]` — with no error. The symptom was a
  capture where every slotted child had simply vanished. Pair the source slots with the cloned
  ones by index and ask the source. Related: MOVE the already-prepared light-DOM clones into
  the slot rather than re-cloning from source, or they lose the form state, inlined images and
  positioning the earlier passes gave them.
- **A canvas tainted once is tainted forever, so use a FRESH scratch canvas per conversion.**
  The flag lives on the canvas, not on the draw. Share one scratch across the page and the
  first cross-origin video poisons every same-origin canvas drawn after it into a placeholder
  — which looks exactly like a CORS problem on elements that do not have one.
- **`cssText` LOSES a var() shorthand once a longhand of it follows** (#87). `background:
  var(--x); background-size: 80px` serializes as `background-image: ; ... background-size:
  80px` in Chrome 151, and the var() text is gone from `rule.style` and `styleMap` too, so
  re-serializing from the CSSOM cannot recover it. `cssResources.ts` spots the empty longhand
  and uses the sheet's AUTHORED text (`<style>` text, or the `<link>` refetched), only when that
  still parses to the live sheet's rule count; an insertRule-built sheet keeps the lossy cssText.
  Specimen `/hostile/#bg-var`: grey without the fallback (79.27 mean diff), stripes with.
  **Shadow roots too** (#94): `shadowDom.ts` rewrites rule by rule, so the whole-sheet fallback
  does not fit. `splitRuleText` cuts the shadow `<style>`'s text into top-level rules, index-
  matched to the parsed sheet (count must agree; a lossy rule's prelude must parse to the same
  selector) and a lossy rule takes its authored block, recursing into @media/@supports.
  **adoptedStyleSheets cannot be recovered**: a constructed sheet keeps no source text. Those
  rules, and document sheets the #87 fallback refused, count in `report.lostDeclarations`.
  Not covered: @keyframes steps (emitted by cssText whole). Specimen `/hostile/#shadow-bg-var`,
  checked over CDP: `<style>` and `@media` cells 0.00 diff with the fix,
  118.54 (grey) without; adopted cell grey either way, `lostDeclarations: 1`. Whole stage with
  the figure masked 12.14 both ways (#87: 12.12).
- **`url()` in a style ATTRIBUTE is not in any stylesheet.** `cssResources.ts` walks
  `document.styleSheets`; an inline `style="background-image:url(…)"` is in none of them, has
  no `cssRules` and no href, so it sailed past every bit of the CSS path and rendered as an
  empty box. Found by specimen, not by reasoning. Inline styles resolve against the DOCUMENT,
  unlike a sheet's own rules.
- **Relative `url()` resolves against the SHEET, not the page** — and re-resolving
  unconditionally is how to stop caring whether Chrome's `cssText` already absolutised it,
  since `new URL(absolute, base)` is a no-op. `demo/public/hostile-external.css` is the
  specimen: it is linked from `/hostile/` but lives at `/`, so resolving against the document
  asks for `/hostile/fonts/…` and 404s. This is what made self-hosted `@font-face` silently
  fall back before the rewrite.
- **A `<video>` in a BACKGROUNDED tab will mislead you twice.** For several seconds after load
  it sits at `readyState` 0 with `networkState` NETWORK_LOADING and `videoWidth` 0 even though
  the file serves fine — capture correctly placeholders it, which looks identical to a CORS
  refusal. Once it does decode it stays paused at `currentTime` 0, so it captures as a
  freeze-frame. A `canvas.captureStream()` video has no demuxer behind it and reaches
  readyState 4 immediately even when hidden (verified 260x150), which is the only way to
  exercise the video path on this box.
- **Measured before optimizing, and the expected bottleneck was not one.** The per-element
  `getComputedStyle` sweep costs 0.5ms over the hostile page's 50 elements (pairing another
  0.5ms) against ~15ms for the whole grab, so the planned MutationObserver-invalidated index
  cache would buy ~3% and was not built. `encodeURIComponent` over the SVG runs 8.4ms/MB and
  is 1.3ms at the hostile page's 164KB. The actual cost is `toDataURL`: 2.5ms for one canvas
  and 3.9ms for two videos, and it cannot be cached, because a canvas or video that has not
  changed is not the case worth optimizing. Post-hardening: demo page 4.2ms median / 12.4ms
  p95, hostile page 12.6ms / 17.4ms, both 1920x885.
- **Two counters in `pipeline.ts`, on purpose.** Keyframe requests index the INPUT stream; mosh
  decisions index the OUTPUT stream. Sharing one made the GOP cadence lag and go erratic as soon
  as backpressure started dropping frames.

## Why each codec moshes differently

Measured 2026-09-18 on this M4 in Chrome: 1440x900 synthetic scene (real page capture as
backdrop, a 300px scroll jump landing exactly on the keyframe, a bright square + "now" moving
throughout), GOP 12, every keyframe after frame 0 dropped. **Moshing is a DECODER phenomenon**:
the whole effect is what a decoder does with a delta whose keyframe it never received.

- **AVC / HEVC (VideoToolbox) are the only codecs with the classic mosh.** H.264 and HEVC reset
  their entropy coder (CABAC) at every slice, so a delta after a dropped IDR still PARSES
  perfectly; only the reference pixels are wrong, and the motion vectors drag stale texture
  around — the moving "now" pulls the background with it. AVC decoded every one of 24
  post-drop frames with no error, error growing monotonically (mean diff 17 -> 32). HEVC
  tolerated ~10 frames, slowly healing through intra blocks, then died and recovered.
- **VP9 cannot mosh, and that is not a bug.** VP9 and AV1 carry backward-adapted probability
  contexts across frames; the keyframe resets them. Drop it and the decoder's contexts no
  longer match the encoder's, so the deltas are bit-level gibberish. libvpx and the
  VideoToolbox VP9 decoder both reject the FIRST post-drop delta (0 moshed frames, software
  and hardware alike); recovery lands within ~4 frames, so all a viewer sees is a stutter and a
  clean snap. No configuration changes this.
- **AV1 gives one or two frames of gibberish in a 2x2 grid.** Same entropy desync as VP9, but
  the VideoToolbox AV1 decoder (M3+; dav1d, the software decoder, rejects instantly like VP9)
  emits 1–2 garbage frames before erroring. Chromium's libaom setup uses
  `tile_columns_log2 = tile_rows_log2 = 1` whenever it gets 4–7 threads, which is any encode
  area between 1280x720 and 1920x1080 — a normal laptop viewport. Each tile has its own symbol
  decoder, so each quadrant desyncs into a DIFFERENT kind of garbage and the tile grid becomes
  the composition. Measured at 1440x900: pixel discontinuity at x=768 was 46.7 against a median
  of 0.4, and y=512 was 24.8 — precisely the tile boundaries. Thread/tile table from
  `media/base/video_encoder.cc` + `media/video/av1_video_encoder.cc`: <640x480 area: 1 tile;
  up to 720p: 2x1; up to 1080p: 2x2; up to 4K: 4x2; 4K+: 4x4. Not the quantizer.
- Consequence, and this is why the order changed: `CODEC_PREFERENCE` is now
  **`avc → hevc → vp9 → av1`** (VP9 ahead of AV1 since 2026-10-09: more devices encode it). It
  used to lead with AV1 for artifact quality, which meant the default codec was the one that
  structurally cannot do the classic mosh. AV1 and VP9 are still reachable — by family, or by
  `codecPreference` — and their per-codec defaults turn moshing off, because on them it is a
  stutter rather than a look. Where AVC has no quantizer mode the default probe now lands on
  VP9; `preferMoshable` asks for AVC in any mode instead (see the VideoToolbox note above).
- `avc1.42001f` is Baseline level 3.1, which caps the coded area at 921,600 px; above that
  `isConfigSupported` is simply false for that string. Use a higher level (`avc1.64002a`) if
  AVC should work on big viewports.

## Mosh settings that actually work

Measured on AV1, 24 frames each, all with zero errors after the recovery fix. The GOP sets how
often a bloom can happen, because there is nothing to drop between keyframes.

| GOP | mosh | painted | moshed | resets | feel |
|-----|------|---------|--------|--------|------|
| 8   | drop all keys | 10/24 | 4 | 2 | constant churn, never settles |
| 20  | drop all keys | 20/24 | 1 | 0 | **mostly coherent, occasional collapse — the classic look** |
| 40  | drop all keys | 21/24 | 0 | 0 | too long; no keyframe arrived, so nothing moshed |
| 20  | + 5% delta drop  | 14/24 | 3 | 1 | coherent with persistent tearing |
| 20  | + 15% delta drop | 9/24  | 4 | 2 | very degraded |
| inf | + 8% delta drop  | 14/24 | 3 | 1 | continuous decay, no keyframes involved |

Verified visually at GOP 12 / coarseness 0.8: displaced macroblocks, text half-replaced by
material from other frames, the gradient band torn into offset rectangles. The demo panel ships
these as presets.
