/**
 * The source/clone element pairing every capture pass works against.
 *
 * WHY THIS EXISTS AS A SHARED THING. The passes have to look at the live element (computed
 * style, measured box, scroll offsets, canvas bitmaps — none of which cloneNode copies) while
 * writing to its counterpart in the clone. The existing trick for that is index matching: walk
 * both trees in document order and trust the i-th element of one to be the i-th of the other.
 *
 * That is only true as long as nobody has mutated the clone. Three of the passes DO mutate it —
 * a sticky element gains an in-flow spacer, a <canvas> is swapped for an <img>, a shadow root is
 * flattened in — so any pass that runs its own querySelectorAll AFTER one of those has run gets
 * a shifted index and silently styles the wrong element, with no error anywhere. Building the
 * pairing once, up front, and handing the same array to every pass removes the whole class of
 * bug: these are direct references, and replaceWith()/before() preserve sibling position.
 */

export interface ElementPair {
  readonly src: Element
  readonly dst: Element
  /**
   * Computed style of the SOURCE, resolved at most once per capture.
   *
   * Lazy because most elements never need it, and shared because several passes each used to
   * call getComputedStyle on the same element — syncScrollState alone called it up to six
   * times per element. It is the single most expensive thing in the capture path.
   */
  readonly cs: CSSStyleDeclaration
}

function makePair(src: Element, dst: Element): ElementPair {
  let cs: CSSStyleDeclaration | null = null
  return {
    src,
    dst,
    get cs() {
      return (cs ??= getComputedStyle(src))
    },
  }
}

/**
 * Pair the root and every descendant element, in document order.
 *
 * Stops at the shorter of the two walks, as the existing passes do: a mismatch means something
 * has already gone wrong, and half a correct capture beats an exception in the render loop.
 */
export function pairElements(source: Element, clone: Element): ElementPair[] {
  const src = [source, ...Array.from(source.querySelectorAll('*'))]
  const dst = [clone, ...Array.from(clone.querySelectorAll('*'))]
  const out: ElementPair[] = []
  for (let i = 0; i < src.length && i < dst.length; i++) out.push(makePair(src[i]!, dst[i]!))
  return out
}

/**
 * Pair the DESCENDANTS of two roots, without pairing the roots themselves.
 *
 * For a shadow root and the fragment it was cloned into: neither root is an element, and there
 * is nothing to project onto a DocumentFragment anyway.
 */
export function pairDescendants(source: ParentNode, clone: ParentNode): ElementPair[] {
  const src = Array.from(source.querySelectorAll('*'))
  const dst = Array.from(clone.querySelectorAll('*'))
  const out: ElementPair[] = []
  for (let i = 0; i < src.length && i < dst.length; i++) out.push(makePair(src[i]!, dst[i]!))
  return out
}
