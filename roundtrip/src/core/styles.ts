/**
 * The occlusion layer's CSS, as a string injected at runtime rather than as a .css file.
 *
 * WHY A STRING. The package has to be droppable onto a page we do not own — from the IIFE
 * bundle, or as a React island inside someone else's build. A `.css` import is a build-tool
 * contract: it only works if the consumer's bundler handles CSS imports the way Vite does, and
 * it gives an injected <script> no way to bring its styles with it at all. Injecting is the one
 * form that works in every case, and the rules below are non-negotiable for correctness (the
 * canvas MUST be opaque and exactly cover the content), not cosmetic, so leaving them to the
 * consumer to wire up is not an option either.
 */
export const ROUNDTRIP_CSS = `
/*
 * The occlusion layer.
 *
 * The canvas must be OPAQUE and cover the content exactly. It must never receive events and
 * never enter the accessibility tree — the real DOM underneath does both.
 */
.rt-root {
  position: relative;
  isolation: isolate; /* keep the overlay out of the host page's stacking games */
}

.rt-content {
  /*
   * Deliberately NOT visibility:hidden, display:none or opacity:0. All three break capture
   * (the first two also drop out of the a11y tree and stop hit-testing). The content stays
   * fully painted and fully interactive; it is simply covered up.
   */
  position: relative;
  z-index: 0;
  /*
   * THE COMPONENT OWNS THE SCROLL CONTAINER. Give .rt-root a bounded height and the content
   * scrolls inside it while the canvas, a sibling pinned to the root, stays put — so the
   * round-tripped image never scrolls out from under itself. With an unbounded root, height
   * resolves to auto and this is inert, so it is safe as a default.
   *
   * Scrolling is also the strongest motion the piece gets: it moves the entire frame at once,
   * which is the single best way to make an encoder fall apart.
   */
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
}

.rt-canvas {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none; /* the browser hit-tests straight through to the real element */
  background: canvas;
}

/* Nothing is painted until the first frame decodes; until then, show the real content. */
.rt-root[data-status='idle'] .rt-canvas,
.rt-root[data-status='unsupported'] .rt-canvas,
.rt-root[data-status='error'] .rt-canvas {
  display: none;
}

.rt-status {
  position: absolute;
  z-index: 2;
  left: 0;
  bottom: 0;
  font: 11px ui-monospace, Menlo, monospace;
  color: #b00;
  background: #fff;
  padding: 2px 6px;
  pointer-events: none;
}
.rt-status:empty {
  display: none;
}
`

/** Marks our injected <style> so a second mount in the same document reuses it. */
const MARKER = 'data-rt'

/**
 * Inject the stylesheet into `doc`, once.
 *
 * Idempotent on purpose: every entry point calls it (the React wrapper from a LAYOUT effect,
 * so the rules land before the first paint rather than one frame after it; `createRoundTrip`
 * defensively, so the vanilla and IIFE paths are covered without the caller knowing) and
 * multiple RoundTrips on one page share the single tag.
 */
export function ensureStyles(doc: Document = document): void {
  if (typeof doc === 'undefined' || !doc.head) return
  if (doc.querySelector(`style[${MARKER}]`)) return
  const style = doc.createElement('style')
  style.setAttribute(MARKER, '')
  style.textContent = ROUNDTRIP_CSS
  doc.head.appendChild(style)
}
