# Contributing

## What is in this repo

npm workspaces, two of them:

- **`roundtrip/`**: the library, published as
  [`@kcuf.biz/video-round-tripper`](https://www.npmjs.com/package/@kcuf.biz/video-round-tripper).
  In development it is source-only (its `exports` point at `src/*.ts`); `npm run build:lib`
  produces the real package. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **`demo/`**: test pages for the library, consuming its source directly. Not published.
  - `/`: the React demo, with a panel for every dial and the presets from the mosh table.
  - `/hostile/`: the capture torture test. One specimen per thing that degrades silently
    (fonts, scroll, fixed and sticky elements, shadow DOM, CSS animations, video, canvas),
    mounted through `mountRoundTrip`, with the capture report read live.
  - `/compare/`: all four codec families side by side at one coarseness, mosh off. The
    per-codec tables in `roundtrip/src/quantizer.ts` are judged here.
  - `/video/`: the two ways capture handles a `<video>` (composited and embedded), with how
    often each keeps the frame, and an iOS image-size sweep. Open it on an iPhone after
    touching video capture.

## Setup

Node 24 (what CI uses) and any npm 11.

```sh
npm install
npm run dev          # the demo on http://127.0.0.1:5394
```

| command | what it does |
|---|---|
| `npm run dev` | the demo pages, Vite on 127.0.0.1:5394 |
| `npm run build` | typecheck and build the demo |
| `npm run build:lib` | build the package into `roundtrip/dist` (ESM, IIFE, declarations; the order matters, see ARCHITECTURE.md) |
| `npm run pack` | `build:lib`, then `npm pack` into `roundtrip/` |
| `npm run typecheck` | both workspaces |
| `npm test` | vitest over the pure modules |
| `npm run serve:tailnet` | optional: expose the dev server over HTTPS with Tailscale, see below |

## Testing

`npm test` covers only the PURE modules (`quantizer`, `mosh`, `frameBudget`, `probe`,
`codecs`, `framerate`, the string passes of the capture seam) and `pipeline` against a fake
encoder. Anything touching WebCodecs, canvas or the DOM is verified in a real browser instead:
jsdom would happily pass code that cannot work.

**Verify in real Chrome.** WebCodecs results depend on the encoders the browser actually has.
chrome-headless-shell (what Playwright's bundled Chromium and most headless setups run) renders
through SwiftShader and has no hardware encoders: no HEVC, and H.264 only in constant bitrate
with no quantizer mode, so the probe picks AV1 and every visual check runs on a codec no real
visitor gets. Use an installed Chrome; with Playwright (not a dependency here, install it where
you need it) that is `chromium.launch({ channel: 'chrome', headless: true, args:
['--headless=new'] })`, with a fresh profile per launch, closed on every exit path. Watch out for
backgrounded tabs: `requestAnimationFrame` stops and CSS animations freeze there, and both
look like bugs (see ARCHITECTURE.md).

## Viewing it on a phone

- **HTTPS is not optional: WebCodecs is a SECURE-CONTEXT API.** Over plain `http://` to a LAN
  address, `VideoEncoder` is simply `undefined` and the piece cannot run. Put the loopback dev
  server behind something that terminates TLS (a tunnel or a local reverse proxy with a
  certificate) rather than `vite --host`.
- Vite rejects requests whose Host header it does not recognise (its DNS-rebinding guard), so
  add your HTTPS hostname to `server.allowedHosts` in the Vite config, rather than `true`. The
  configs allow `.ts.net` (Tailscale), which is what the `serve:tailnet` scripts use.
- The demo panel's "This device" block reports secure-context, WebCodecs availability and the
  codec actually picked — the things you cannot otherwise inspect on a phone.
## Releases

The package is published from GitHub Actions (`.github/workflows/publish.yml`) through npm's
trusted publishing, so no npm token exists anywhere:

1. Bump `version` in `roundtrip/package.json` and commit.
2. Push a matching tag, `v<version>`. Pushing the tag is the release: the workflow checks the
   tag against the version, runs the typecheck and tests, and publishes.

`roundtrip/README.md` is a copy of this repo's README (npm shows the package folder's README);
packing refuses to run if they differ, so `cp README.md roundtrip/` before packing locally. CI and
the publish workflow copy it themselves, so a README edit alone never fails a push. Before a
release that touches the build or `exports`, pack it and install the tarball into a scratch
project: the `exports` swap around packing has failed silently before.

## Notes for the curious

- Issue numbers like `(#62)` in the notes and comments refer to the author's own tracker, which
  is not public; they are labels for searching, nothing more.
- The project is built agent-led, and `CLAUDE.md` is the entry point for coding agents. The
  engineering knowledge itself is in ARCHITECTURE.md, for humans and agents alike.
