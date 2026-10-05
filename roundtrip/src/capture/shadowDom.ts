/**
 * Shadow DOM, flattened into the clone.
 *
 * XMLSerializer does not traverse shadow roots — it writes the host element and stops. A web
 * component therefore serializes as an empty tag, and since that produces no error and no
 * console warning, the only symptom is that part of the page is missing from the video.
 *
 * "Flattened" here means what the browser means by the flat tree: the shadow root's children
 * take the host's place, and each <slot> is replaced by the nodes actually assigned to it.
 *
 * MOVE the light children, do not re-clone them. The assigned nodes already exist in the
 * clone — they are the host's own children — and by the time this pass runs they have had
 * form state projected onto them, their images inlined and their positioning resolved. Cloning
 * the source nodes afresh would throw all of that away and quietly produce a slot whose
 * contents are a frame or two stale and missing their pixels.
 *
 * The shadow boundary itself cannot survive: the SVG document has one flat scope, so shadow
 * CSS has to be rewritten to be selective by hand. `:host` becomes an attribute selector on
 * the host and every other selector is scoped under it, which reproduces encapsulation in the
 * one direction that matters here (shadow rules not leaking out). Rules leaking IN is the
 * remaining inaccuracy and is accepted: a page rule that would have been blocked by the
 * boundary can now match shadow content.
 */

import type { ElementPair } from './pairs.ts'
import type { ResourceCache } from './inlineResources.ts'
import type { CaptureReport } from './report.ts'
import { inlineCssUrls, lostDeclarations } from './cssResources.ts'
import { rewriteStateRules } from './interactionState.ts'

/* ------------------------------------------------------------------ pure selector rewriting */

/** Index of the matching ')' for the '(' at `open`, or -1. Depth-aware, so :is(a,(b)) works. */
function closeParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/**
 * Split a selector list on its TOP-LEVEL commas only. `:is(a, b)` and `[title="a,b"]` are one
 * selector each; splitting them would produce two broken ones.
 */
export function splitSelectorList(selectorText: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < selectorText.length; i++) {
    const c = selectorText[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(selectorText.slice(start, i))
      start = i + 1
    }
  }
  out.push(selectorText.slice(start))
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

function rewriteOne(sel: string, host: string): string {
  let out = sel
  let scoped = false

  if (out.startsWith(':host-context(')) {
    // :host-context(X) means "the host has an ancestor matching X", which is exactly what the
    // descendant combinator says in a flat tree.
    const close = closeParen(out, ':host-context'.length)
    if (close !== -1) {
      const cond = out.slice(':host-context('.length, close).trim()
      out = `${cond} ${host}${out.slice(close + 1)}`
      scoped = true
    }
  } else if (out.startsWith(':host(')) {
    const close = closeParen(out, ':host'.length)
    if (close !== -1) {
      // The condition is a compound on the host itself, so it concatenates with no combinator.
      out = `${host}${out.slice(':host('.length, close).trim()}${out.slice(close + 1)}`
      scoped = true
    }
  } else if (out === ':host' || /^:host(?![\w-])/.test(out)) {
    out = host + out.slice(':host'.length)
    scoped = true
  }

  if (!scoped) out = `${host} ${out}`

  // In the flat tree an assigned node sits where its <slot> was, so ::slotted(X) is just X.
  for (;;) {
    const at = out.indexOf('::slotted(')
    if (at === -1) break
    const close = closeParen(out, at + '::slotted'.length)
    if (close === -1) break
    out = out.slice(0, at) + out.slice(at + '::slotted('.length, close).trim() + out.slice(close + 1)
  }

  return out.replace(/\s+/g, ' ').trim()
}

/** Scope one selector list to a flattened shadow host. */
export function rewriteSelector(selectorText: string, host: string): string {
  return splitSelectorList(selectorText)
    .map((s) => rewriteOne(s, host))
    .join(', ')
}

/* -------------------------------------------------------------------------- the DOM side */

/**
 * Stable per-root ids, not the walk order.
 *
 * The host selector is baked into the rewritten CSS, which is memoised; keying that memo on a
 * position in the document would invalidate every root as soon as one element moved.
 */
const ROOT_ID = new WeakMap<ShadowRoot, number>()
let nextRootId = 0
const rootId = (root: ShadowRoot): number => {
  let id = ROOT_ID.get(root)
  if (id === undefined) ROOT_ID.set(root, (id = nextRootId++))
  return id
}

/* ------------------------------------------------------------- authored text, per rule (#94) */

/** One top-level rule as WRITTEN: its prelude, and its block's inside (null for a statement). */
export interface RuleText {
  prelude: string
  body: string | null
}

/**
 * Split stylesheet text into its top-level rules, without interpreting any of them.
 *
 * Exists for the same hole #87 guarded for document sheets: `background: var(--x);
 * background-size: 8px` in one rule serializes as `background-image: ;` and the var() text is
 * gone from the CSSOM entirely. Shadow CSS is rewritten rule by rule, so the whole-sheet
 * fallback cssResources.ts uses does not fit; this gives each rule its own authored block to
 * fall back to. Comments and strings are skipped so a brace inside either cannot end a block.
 * @import and @charset are dropped, because a constructed sheet drops them too and the result
 * is index-matched against one.
 */
export function splitRuleText(css: string): RuleText[] {
  const out: RuleText[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0 // where the current rule's prelude began
  let bodyStart = -1
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '{') {
      if (depth++ === 0) bodyStart = i + 1
    } else if (c === '}' && depth > 0) {
      if (--depth === 0) {
        out.push({ prelude: css.slice(start, bodyStart - 1), body: css.slice(bodyStart, i) })
        start = i + 1
      }
    } else if (c === ';' && depth === 0) {
      out.push({ prelude: css.slice(start, i), body: null })
      start = i + 1
    }
  }
  return out
    .map((r) => ({ ...r, prelude: r.prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim() }))
    .filter((r) => r.prelude !== '' && !/^@(import|charset)\b/i.test(r.prelude))
}

/** Whether `prelude` parses to the selector the live rule holds: the per-rule check on the pairing. */
function sameSelector(prelude: string, selectorText: string): boolean {
  try {
    const probe = new CSSStyleSheet()
    probe.replaceSync(`${prelude}{}`)
    const rule = probe.cssRules[0]
    return rule instanceof CSSStyleRule && rule.selectorText === selectorText
  } catch {
    return false
  }
}

/** Rewritten (but not yet url-inlined) shadow CSS, memoised — the rewrite is the slow half. */
const ROOT_CSS = new WeakMap<ShadowRoot, { css: string; lost: number }>()

/**
 * `authored` is the same level of the sheet as text, or null when there is none (an adopted
 * sheet). It is trusted only while it holds exactly as many rules as the CSSOM does — a rule
 * the parser rejected shifts every index after it — and a lossy style rule takes its authored
 * block only if that rule's prelude parses to the same selector. Anything else keeps the lossy
 * cssText and is counted, so the loss shows in report() instead of as a quietly blank box.
 */
function rewriteRules(rules: CSSRuleList, host: string, authored: RuleText[] | null, lost: { n: number }): string {
  const list = Array.from(rules)
  const text = authored !== null && authored.length === list.length ? authored : null
  let out = ''
  list.forEach((rule, i) => {
    const own = text?.[i]
    if (typeof CSSStyleRule !== 'undefined' && rule instanceof CSSStyleRule) {
      let body = rule.style.cssText
      if (lostDeclarations(rule)) {
        if (own?.body != null && sameSelector(own.prelude, rule.selectorText)) body = own.body
        else lost.n++
      }
      out += `${rewriteSelector(rule.selectorText, host)}{${body}}\n`
    } else if (typeof CSSGroupingRule !== 'undefined' && rule instanceof CSSGroupingRule) {
      // @media / @supports / @container: the condition survives, the selectors inside do not.
      const css = rule.cssText
      const head = css.slice(0, css.indexOf('{'))
      const inner = own?.body != null && own.prelude.startsWith('@') ? splitRuleText(own.body) : null
      out += `${head}{\n${rewriteRules(rule.cssRules, host, inner, lost)}}\n`
    } else {
      // @font-face, @keyframes, @property: no selectors, and all of them are document-scoped
      // in the flat tree anyway.
      out += rule.cssText + '\n'
    }
  })
  return out
}

/**
 * What #94 covers and what it does not. A shadow `<style>` is covered: its textContent is the
 * authored text, so a rule whose cssText lost a var() shorthand gets its block back, nested
 * inside @media/@supports too. An ADOPTED sheet is not: a constructed sheet keeps no source
 * text anywhere (replaceSync's argument is gone once parsed), so its lossy rules are emitted as
 * the CSSOM has them and counted in `report.lostDeclarations`. Neither are @keyframes steps,
 * which go out by cssText whole.
 */
function shadowCss(root: ShadowRoot, host: string): { css: string; lost: number } {
  const memo = ROOT_CSS.get(root)
  if (memo !== undefined) return memo

  const lost = { n: 0 }
  let raw = ''
  for (const sheet of Array.from(root.adoptedStyleSheets ?? [])) {
    try {
      raw += rewriteRules(sheet.cssRules, host, null, lost)
    } catch {
      /* a constructed sheet should always be readable; if not, skip it */
    }
  }
  for (const style of Array.from(root.querySelectorAll('style'))) {
    // Parse through the CSSOM rather than by hand: selector text is the only part being
    // rewritten and everything else should come back byte-for-byte as the engine sees it.
    try {
      const text = style.textContent ?? ''
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(text)
      const authored = Array.from(sheet.cssRules).some(lostDeclarations) ? splitRuleText(text) : null
      raw += rewriteRules(sheet.cssRules, host, authored, lost)
    } catch {
      /* unparseable: dropping it is better than leaking it unscoped into the document */
    }
  }

  // :host(:hover) and friends need the same treatment as the page's own sheets.
  const result = { css: rewriteStateRules(raw), lost: lost.n }
  ROOT_CSS.set(root, result)
  return result
}

/**
 * A custom element that is DEFINED, has no open shadow root, and has no children at all will
 * serialize as an empty tag while still occupying a box on the page — which is what a closed
 * shadow root looks like from outside.
 *
 * This is a heuristic and it is documented as one. A closed root cannot be detected: the spec
 * exists precisely so that outside code cannot reach it, and element.shadowRoot is null whether
 * the root is closed or simply absent. It will miss any closed root whose host also has light
 * children, and it will false-positive on a custom element that renders nothing by design.
 * An honest undercount beats a confident wrong number.
 */
function looksClosed(el: Element): boolean {
  return (
    el.localName.includes('-') &&
    el.shadowRoot === null &&
    el.childNodes.length === 0 &&
    typeof customElements !== 'undefined' &&
    customElements.get(el.localName) !== undefined
  )
}

/**
 * Flatten every open shadow root reachable from `pairs` into the clone, returning the CSS the
 * flattened trees need.
 *
 * `runPasses` is injected rather than imported so this module does not have to depend on the
 * composer that calls it. It runs the ordinary pass set over a freshly paired subtree, and
 * calls back into here for nested roots.
 */
export async function flattenShadowRoots(
  pairs: readonly ElementPair[],
  cache: ResourceCache,
  report: CaptureReport,
  runPasses: (subPairs: ElementPair[]) => Promise<string>,
  pairUp: (src: ParentNode, dst: ParentNode) => ElementPair[],
): Promise<string> {
  let css = ''

  for (const { src, dst } of pairs) {
    if (looksClosed(src)) report.closedShadowRoots++
    const root = src.shadowRoot
    if (!root) continue

    const host = `[data-rt-sh="${rootId(root)}"]`
    dst.setAttribute('data-rt-sh', String(rootId(root)))

    const doc = dst.ownerDocument
    const frag = doc.createDocumentFragment()
    for (const node of Array.from(root.childNodes)) frag.appendChild(node.cloneNode(true))

    /*
     * Pair FIRST, then drop the <style>s. The pairing is index-matched against the live root,
     * which still has its <style> elements; removing them from the clone beforehand shifted
     * every pair by one, so each pass styled the element BEFORE the one it meant to (#74: the
     * shadow specimen's animated bar was paired with the root's <style> and never frozen, and
     * any shadow root opening with a <style> had its form state, positioning and replacement
     * applied one element off). Pairs hold references, so removing afterwards is safe.
     */
    const shadowPairs = pairUp(root, frag).filter((p) => p.src.localName !== 'style')

    // <style> elements would apply unscoped in the flat document — their text goes into the
    // returned CSS, rewritten, and the elements themselves do not travel.
    for (const style of Array.from(frag.querySelectorAll('style'))) style.remove()

    // Pass set over the shadow content itself, BEFORE slots are resolved: the pairing is
    // node-for-node with the shadow root only while the structure still matches.
    css += await runPasses(shadowPairs)

    // The host's own light children, already fully prepared, indexed so a slot can take them.
    const lightDst = new Map<Node, Node>()
    const srcKids = Array.from(src.childNodes)
    const dstKids = Array.from(dst.childNodes)
    for (let i = 0; i < srcKids.length && i < dstKids.length; i++) {
      lightDst.set(srcKids[i]!, dstKids[i]!)
    }

    /*
     * assignedNodes() MUST be asked of the LIVE slot, never the cloned one.
     *
     * Slot assignment is a property of being in a shadow tree. A cloned <slot> sitting in a
     * DocumentFragment is just an unknown element, so assignedNodes() on it returns [] --
     * silently. The symptom was a capture where every slotted child had vanished and the
     * <slot> sat there empty, with nothing logged anywhere. The two lists are index-aligned
     * because the fragment is a node-for-node clone of the shadow root and no pass before
     * this one adds or removes a <slot>.
     */
    const srcSlots = Array.from(root.querySelectorAll('slot'))
    const dstSlots = Array.from(frag.querySelectorAll('slot'))
    for (let i = 0; i < srcSlots.length && i < dstSlots.length; i++) {
      const taken: Node[] = []
      for (const node of srcSlots[i]!.assignedNodes({ flatten: true })) {
        // The prepared clone when this is one of the host's own children; otherwise a fresh
        // clone (flatten:true can reach a nested slot's fallback content, which has none).
        taken.push(lightDst.get(node) ?? node.cloneNode(true))
      }
      if (taken.length > 0) dstSlots[i]!.replaceWith(...taken)
      // Nothing assigned: the browser renders the slot's own fallback children, and so do we,
      // by leaving the <slot> in place as a plain inline element.
    }

    // Whatever light children were not slotted are not rendered by the browser either.
    for (const node of dstKids) if (node.parentNode === dst) dst.removeChild(node)
    dst.appendChild(frag)

    const sheet = shadowCss(root, host)
    report.lostDeclarations += sheet.lost
    css += (await inlineCssUrls(sheet.css, doc.baseURI, cache)) + '\n'
  }

  return css
}
