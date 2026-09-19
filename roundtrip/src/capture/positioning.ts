/**
 * Everything whose position in the clone is not the position the markup implies.
 *
 * Three cases, in increasing order of how much time each one cost:
 *   scroll offset — a PROPERTY, so cloneNode drops it
 *   position:fixed — re-anchored by the transforms the scroll fix applies
 *   position:sticky — in flow, so the fixed treatment alone reflows its siblings
 *
 * All of it works from LIVE measurements of the source: the clone renders in a document with
 * no scrollports, no viewport of its own and no sticky behaviour, so none of these can be
 * expressed there declaratively. They have to be resolved to plain geometry here.
 */

import type { ElementPair } from './pairs.ts'

/**
 * Scroll position is a PROPERTY, not an attribute, so cloneNode() drops it: a scrolled
 * container would capture as though it were scrolled to the top. Same class of problem as
 * form state, and it matters more here, because the component is designed to own a scroll
 * container so the canvas can stay put while the content moves under it.
 *
 * The clone renders in a separate document where scrollTop means nothing, so the scrolled
 * appearance has to be reproduced geometrically: clip the scroller and shift its children.
 *
 * WHY EACH CHILD RATHER THAN ONE WRAPPER: wrapping a scroller's children in a single
 * translated div is the obvious implementation and it is wrong. If the scroller is a flex or
 * grid container the wrapper becomes its only item and the whole layout collapses; it also
 * breaks any `>` child selector. Transforming each child individually shifts them all by the
 * same amount — which is exactly what scrolling looks like — while touching neither layout
 * nor selector matching, because transforms are paint-only.
 */
export function syncScrollState(source: Element, pairs: readonly ElementPair[]): void {
  // Computed styles are resolved once per element by the pairing and shared with every other
  // pass; this loop alone used to ask for them up to six times per element.
  const byNode = new Map<Element, ElementPair>()
  for (const pair of pairs) byNode.set(pair.src, pair)

  for (const { src: s, dst: d0 } of pairs) {
    const top = s.scrollTop
    const left = s.scrollLeft
    if (top === 0 && left === 0) continue

    if (!(d0 instanceof HTMLElement)) continue
    d0.style.overflow = 'hidden'

    const srcKids = Array.from(s.children)
    const dstKids = Array.from(d0.children)
    for (let j = 0; j < srcKids.length && j < dstKids.length; j++) {
      const sk = srcKids[j]!
      const dk = dstKids[j]
      if (!(dk instanceof HTMLElement)) continue
      const kidPos = byNode.get(sk)?.cs.position
      // A fixed child is anchored to the viewport, not to the scroller: it must NOT move.
      // Nor may a sticky one, which is converted to absolute below — apply both the translate
      // and the absolute offset and the element lands twice as far away as it should.
      if (kidPos === 'fixed' || kidPos === 'sticky') continue
      // Preserve whatever transform the child already had; the scroll offset composes as the
      // OUTERMOST operation (rightmost applies first), so the element is shifted after its
      // own transform rather than instead of it.
      const existing = byNode.get(sk)?.cs.transform
      const own = existing && existing !== 'none' ? ' ' + existing : ''
      dk.style.transform = `translate(${-left}px, ${-top}px)${own}`
    }
  }

  /*
   * position:fixed must hold still while the page scrolls under it, and it is the single
   * trickiest thing in this file, because **a transformed element becomes the containing
   * block for its fixed descendants**. Shifting the scroller's children therefore re-anchors
   * every fixed element below them, silently.
   *
   * Compensating with an equal-and-opposite translate is the obvious repair and it is WRONG.
   * It happens to work for `top`-anchored elements, which is exactly why it looks right at
   * first: measured, a top-anchored header went from 17% to 100% identical across a 400px
   * scroll. But a `bottom`-anchored element re-anchors to the bottom of the whole 300vh page
   * rather than the viewport, so it renders far outside the frame and no translate brings it
   * back — the anchor changed, not the offset.
   *
   * So: convert to absolute against whatever the clone's containing block will actually be,
   * using coordinates measured from the live DOM. Offsets measured relative to that block
   * already account for the scroll, because the block itself is shifted by the same amount.
   */
  const clonedTransform = (p: HTMLElement): boolean => {
    const par = p.parentElement
    return (
      !!par &&
      (par.scrollTop !== 0 || par.scrollLeft !== 0) &&
      getComputedStyle(p).position !== 'fixed'
    )
  }

  /** The ancestor the clone will position this element against. */
  const containingBlock = (el: HTMLElement): HTMLElement | null => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (
        p === source ||
        cs.position !== 'static' ||
        cs.transform !== 'none' ||
        cs.filter !== 'none' ||
        cs.perspective !== 'none' ||
        /transform|filter|perspective/.test(cs.willChange) ||
        clonedTransform(p) // static in the source, transformed once we shift it
      ) {
        return p
      }
    }
    return null
  }

  /** Pin the clone where the source actually is, measured against its real containing block. */
  const anchor = (s: HTMLElement, d: HTMLElement, cb: HTMLElement): DOMRect => {
    const r = s.getBoundingClientRect()
    const cbr = cb.getBoundingClientRect()
    d.style.position = 'absolute'
    d.style.left = `${r.left - cbr.left}px`
    d.style.top = `${r.top - cbr.top}px`
    // The offsets above are complete on their own; any of these left set would fight them.
    d.style.right = 'auto'
    d.style.bottom = 'auto'
    d.style.margin = '0'
    return r
  }

  /*
   * position:sticky is the fixed problem plus one more: sticky elements are IN FLOW. Pulling
   * one out to absolute — which is the only way to make it hold still in a document with no
   * scrollport — leaves a gap its siblings immediately close, so every following block jumps
   * up by the sticky element's height. That reads as a layout bug in the video, not as a codec
   * artifact, which is the one thing capture must never do.
   *
   * So it gets an in-flow spacer of the same box in its place. flex:none because in a flex or
   * grid container a bare div would otherwise be stretched or shrunk and reopen the same gap.
   *
   * Only when the scroller is ACTUALLY scrolled: at offset 0 a sticky element is already
   * sitting at its natural in-flow position, and taking it out of flow there can only
   * introduce error. Conservative on purpose.
   */
  const scrolled = (el: Element): boolean => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.scrollTop !== 0 || p.scrollLeft !== 0) return true
      if (p === source) break
    }
    return false
  }

  const spacers: [HTMLElement, HTMLElement][] = []

  for (const pair of pairs) {
    const s = pair.src
    if (!(s instanceof HTMLElement)) continue
    const pos = pair.cs.position
    if (pos !== 'fixed' && pos !== 'sticky') continue
    if (pos === 'sticky' && !scrolled(s)) continue

    const cb = containingBlock(s)
    if (!cb) continue
    const d = pair.dst
    if (!(d instanceof HTMLElement)) continue

    const r = anchor(s, d, cb)

    if (pos === 'sticky') {
      const spacer = d.ownerDocument.createElement('div')
      spacer.setAttribute('data-rt-spacer', '')
      spacer.setAttribute(
        'style',
        `width:${r.width}px;height:${r.height}px;flex:none;` +
          `margin:${pair.cs.marginTop} ${pair.cs.marginRight} ${pair.cs.marginBottom} ${pair.cs.marginLeft}`,
      )
      // Deferred: inserting now would shift the clone's child indices under the loop above.
      spacers.push([d, spacer])
    }
  }

  for (const [d, spacer] of spacers) d.before(spacer)
}
