# video-round-tripper

Round-trips a live web page through a video codec and paints the result back over it.

The point is not fidelity. The point is to put video compression artifacts into a web page
experience and see what they do to it: blocking, banding, ringing, chroma bleed on saturated
type, an interface that macroblocks when you scroll and settles when you stop.

```tsx
import { RoundTrip } from '@video-round-tripper/roundtrip'

<RoundTrip coarseness={0.85} gop="infinite" mosh={{ dropKeyframesAfter: 0 }}>
  <YourPage />
</RoundTrip>
```

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

## Props worth knowing

| prop | what it does |
|---|---|
| `coarseness` | 0–1. The main dial. Mapped per codec — see `quantizer.ts`. |
| `encodeScale` | 0–1. Encode below display resolution and let the canvas upscale. Cheap, very effective. |
| `declaredFramerate` | The lie. Tell the rate controller 60 while feeding it 6 and it starves itself. |
| `gop` | `'infinite'` never sends another keyframe, so error never gets corrected. |
| `mosh` | Drops keyframe chunks *between* encoder and decoder, so deltas apply to a stale reference. The classic bloom. |
| `captureMode` | `'continuous'` or `'on-interaction'`. |
| `disabled` | Bypass. Defaults to on under `prefers-reduced-motion`. |

## Capture

There is no fast, permissionless browser API that rasterizes arbitrary live DOM to frames. This
uses element-scoped `foreignObject` rasterization serialized to a data URI — measured at **8ms
median / 18ms p95 (~125fps)** on the demo page in Chrome 150, untainted, with full font fidelity.
That is ~3x faster than the best library tried, with no dependency.

`getDisplayMedia()` was rejected: it captures the composite, which now includes the opaque
overlay canvas, so it feeds itself an infinite video-feedback mirror. (A legitimate effect to
reach for deliberately — just not as the default.)

Today the component is validated against the demo page in `demo/`. Making it survive arbitrary
third-party DOM is staged work, and all of it lands in one file:
`roundtrip/src/capture/inlineResources.ts`.

## Development

```
npm install
npm run dev        # 127.0.0.1:5394
npm test           # pure modules
npm run typecheck
```

See `CLAUDE.md` for the gotchas — several of them cost real time and none are caught by `tsc`.
