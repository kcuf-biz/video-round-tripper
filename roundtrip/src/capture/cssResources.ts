/**
 * CSS resource inlining.
 *
 * An <img>-loaded SVG is a separate document AND it has external resource loading disabled
 * outright: nothing it references over the network is ever fetched. So every byte a stylesheet
 * needs has to already be sitting inside the string we embed, as a data: URI. What is not
 * inlined here is simply not there, and — the part that costs time — it does not error. It
 * renders the fallback and looks like a broken website rather than like a codec artifact.
 *
 * What this replaces: the first cut inlined fonts from CROSS-ORIGIN <link> sheets only, and
 * only when the url was already absolute and ended in a font extension. That meant a
 * self-hosted @font-face — `url(/fonts/x.woff2)` in the page's own stylesheet, the single most
 * common way anyone ships a webfont — silently fell back. Everything here is one code path now:
 * every sheet, same-origin included, relative urls resolved against the sheet, images as well
 * as fonts, @import followed.
 *
 * The pure string functions at the top are unit-tested (cssResources.test.ts). The async half
 * below them needs a document and a network and is verified in a real browser.
 */

import type { ResourceCache } from './inlineResources.ts'

/* ------------------------------------------------------------------ pure string transforms */

/**
 * Targets that already carry their own bytes, can never be fetched — or, for a bare `#id`,
 * point INTO the document rather than out of it.
 *
 * The fragment case is not like the others and was found by use (backlog #63): `fill:
 * url(#mark-row)` is how CSS reaches every SVG paint server, mask, filter and clip-path, and
 * resolving it made it `http://host/#mark-row` — a url into a different document, which the
 * SVG image cannot load. SVG treats a failed paint as `none`, so kcuf's wordmark captured at 0%
 * ink with no error. Left as authored, the fragment resolves against the image document, which
 * is exactly where the cloned <linearGradient> now lives.
 */
const SELF_CONTAINED = /^(?:#|(?:data|blob|about|javascript):)/i

/**
 * One `url(...)` token: double-quoted, single-quoted, or bare. The inner alternations allow a
 * backslash escape of the closing delimiter, which is legal CSS and shows up in generated
 * sheets. Hex escapes (`\26 `) are NOT decoded — they are vanishingly rare in urls and
 * mis-decoding one would corrupt a working reference, which is worse than skipping it.
 */
const CSS_URL = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|((?:[^)\\\s]|\\.)*))\s*\)/g

/** `@import <prelude>;` — the prelude may carry layer()/supports()/media after the target. */
const IMPORT_RULE = /@import\s+([^;]+);/g

const unescape = (s: string): string => s.replace(/\\(.)/g, '$1')

/**
 * Absolute form of a url() target, or null when there is nothing to fetch.
 *
 * Always re-resolving against the sheet's own href is deliberate. Chrome's
 * `CSSRule.cssText` may hand back the url already absolutised, or as authored, depending on
 * the property and the version — and `new URL(alreadyAbsolute, base)` is a no-op, so resolving
 * unconditionally means the code does not have to know which.
 */
export function resolveCssUrl(raw: string, baseHref: string): string | null {
  const v = raw.trim()
  if (!v || SELF_CONTAINED.test(v)) return null
  try {
    return new URL(v, baseHref).href
  } catch {
    return null // unparseable base or target: leave the rule alone
  }
}

/**
 * Rewrite every url() through `map`. Returning null from `map` leaves that token BYTE-IDENTICAL:
 * a font we could not inline must fall back, not break the rule it lives in. (Absolutising the
 * failed url instead would buy nothing — the SVG document will not load it either way.)
 */
export function rewriteCssUrls(
  css: string,
  baseHref: string,
  map: (absolute: string) => string | null,
): string {
  return css.replace(CSS_URL, (whole, dq?: string, sq?: string, bare?: string) => {
    const raw = dq ?? sq ?? bare ?? ''
    const abs = resolveCssUrl(unescape(raw), baseHref)
    if (abs === null) return whole
    const replacement = map(abs)
    if (replacement === null) return whole
    return `url("${replacement.replace(/["\\]/g, '\\$&')}")`
  })
}

/** Every distinct fetchable url() target in the sheet, absolutised. */
export function collectCssUrls(css: string, baseHref: string): string[] {
  const found = new Set<string>()
  rewriteCssUrls(css, baseHref, (abs) => {
    found.add(abs)
    return null
  })
  return Array.from(found)
}

export interface CssImport {
  /** The target exactly as authored. */
  href: string
  /** Resolved against the importing sheet, or null if it is not fetchable. */
  absolute: string | null
}

/** The leading url() or quoted-string token of an @import prelude. */
function importTarget(prelude: string): string | null {
  const asUrl = /^\s*url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|((?:[^)\\\s]|\\.)*))\s*\)/.exec(prelude)
  if (asUrl) return unescape(asUrl[1] ?? asUrl[2] ?? asUrl[3] ?? '')
  const asString = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(prelude)
  if (asString) return unescape(asString[1] ?? asString[2] ?? '')
  return null
}

export function extractImports(css: string, baseHref: string): CssImport[] {
  const out: CssImport[] = []
  for (const m of css.matchAll(IMPORT_RULE)) {
    const href = importTarget(m[1] ?? '')
    if (href === null) continue
    out.push({ href, absolute: resolveCssUrl(href, baseHref) })
  }
  return out
}

/**
 * Drop the @import rules once their contents have been prepended, so the sheet does not carry a
 * duplicate (and dead — see the header) reference. Imports we failed to fetch go too: an
 * @import that cannot load is not doing anything for us either.
 */
export function stripImports(css: string): string {
  return css.replace(IMPORT_RULE, '')
}

/* --------------------------------------------------------------------- mime and byte budget */

const FONT_URL = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i

const MIME_BY_EXT: Record<string, string> = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
}

/**
 * Prefer what the server says it sent; fall back to the extension. The first cut hardcoded
 * font/woff2 for everything it inlined, which happened to be right only because Google Fonts
 * serves woff2 exclusively.
 */
export function mimeFor(url: string, contentType: string | null): string {
  const declared = contentType?.split(';')[0]?.trim()
  if (declared && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') {
    return declared
  }
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase()
  return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream'
}

export const isFontUrl = (url: string): boolean => FONT_URL.test(url)

/**
 * base64 in 8KB chunks rather than one char at a time. The per-char loop the first cut used is
 * fine for a 60KB font face and quadratic-feeling on a 2MB photograph; apply() over a chunk
 * keeps it linear without risking the argument-count limit.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 8192
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/* ----------------------------------------------------------------------------- the async half */

/**
 * An import chain deeper than this is pathological, and the cap is also what stops a cyclic
 * @import (A imports B imports A) from recursing forever. Linear, not exponential: each level
 * fetches once and the fetch itself is memoised by the cache.
 */
const MAX_IMPORT_DEPTH = 8

/**
 * Resolve every @import and every url() in one sheet's text.
 *
 * Two phases on purpose: the rewrite is a synchronous string pass, so all the fetches are
 * awaited first and the rewrite then reads a Map. Interleaving them would mean an async
 * String.replace, which does not exist.
 */
export async function inlineCssUrls(
  css: string,
  baseHref: string,
  cache: ResourceCache,
  depth = 0,
): Promise<string> {
  let body = css
  let prefix = ''

  const imports = extractImports(css, baseHref)
  if (imports.length > 0) {
    if (depth < MAX_IMPORT_DEPTH) {
      for (const im of imports) {
        if (!im.absolute) continue
        const text = await cache.text(im.absolute)
        if (text === null) continue
        prefix += (await inlineCssUrls(text, im.absolute, cache, depth + 1)) + '\n'
      }
    }
    body = stripImports(body)
  }

  const urls = collectCssUrls(body, baseHref)
  const inlined = new Map<string, string>()
  await Promise.all(
    urls.map(async (url) => {
      const data = await cache.resource(url)
      if (data !== null) inlined.set(url, data)
      else if (isFontUrl(url)) cache.stats.missingFonts++
      else cache.stats.blockedImages++
    }),
  )

  return prefix + rewriteCssUrls(body, baseHref, (abs) => inlined.get(abs) ?? null)
}

/* ------------------------------------------------------------------------- sheet enumeration */

/**
 * A rule whose cssText DROPPED declarations (#87). `background: var(--x); background-size: 8px`
 * in one rule: Chrome holds the shorthand's longhands as pending substitutions, and once one of
 * them is overridden it can serialize none of them. cssText reads `background-image: ;` — an
 * empty value the image document then discards — and neither `rule.style` nor `styleMap` has
 * the var() text any more. Verified in Chrome 151 for `background` and `margin`; any shorthand
 * should do the same. An empty longhand is the tell. Custom properties may legitimately be empty.
 */
function lostDeclarations(rule: CSSRule): boolean {
  const style = (rule as Partial<CSSStyleRule>).style
  if (style) {
    for (let i = 0; i < style.length; i++) {
      const name = style[i]!
      if (!name.startsWith('--') && style.getPropertyValue(name) === '') return true
    }
  }
  const nested = (rule as Partial<CSSGroupingRule>).cssRules
  return nested ? Array.from(nested).some(lostDeclarations) : false
}

/**
 * The sheet as authored, for when the CSSOM cannot reproduce it: the `<style>`'s own text, or a
 * `<link>`'s href fetched again. Only trusted if it still parses to as many rules as the live
 * sheet holds — a sheet script has edited through insertRule (CSS-in-JS does exactly that, into
 * an empty `<style>`) no longer matches its source, and losing one rule beats losing the sheet.
 * @import is left out of the count because a constructed sheet will not parse it.
 */
async function authoredText(sheet: CSSStyleSheet, rules: CSSRuleList, cache: ResourceCache): Promise<string | null> {
  const owner = sheet.ownerNode
  const text =
    owner instanceof HTMLStyleElement ? owner.textContent : sheet.href ? await cache.text(sheet.href) : null
  if (!text || typeof CSSStyleSheet === 'undefined' || typeof CSSImportRule === 'undefined') return null
  const probe = new CSSStyleSheet()
  probe.replaceSync(stripImports(text))
  const live = Array.from(rules).filter((r) => !(r instanceof CSSImportRule)).length
  return probe.cssRules.length === live ? text : null
}

/** How a sheet's text was obtained, and what relative urls inside it resolve against. */
async function sheetText(
  sheet: CSSStyleSheet,
  doc: Document,
  cache: ResourceCache,
  depth: number,
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) return ''

  let rules: CSSRuleList | null = null
  try {
    rules = sheet.cssRules
  } catch {
    rules = null // cross-origin: CSSOM refuses. Fetched below instead.
  }

  // Relative urls in an external sheet resolve against the SHEET, not the document. For an
  // inline <style> or a constructed sheet there is no href, and the document base is correct.
  const base = sheet.href ?? doc.baseURI

  if (rules !== null) {
    const authored = Array.from(rules).some(lostDeclarations) ? await authoredText(sheet, rules, cache) : null
    if (authored !== null) return inlineCssUrls(authored, base, cache)
    let css = ''
    for (const rule of Array.from(rules)) {
      // A readable @import exposes its target as a live sheet — recurse into the CSSOM rather
      // than refetching it, and pick up the right base href for free.
      if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule && rule.styleSheet) {
        css += (await sheetText(rule.styleSheet, doc, cache, depth + 1)) + '\n'
        continue
      }
      css += rule.cssText + '\n'
    }
    return inlineCssUrls(css, base, cache)
  }

  if (!sheet.href) return ''
  const text = await cache.text(sheet.href)
  if (text === null) return ''
  return inlineCssUrls(text, sheet.href, cache)
}

/**
 * Every stylesheet affecting the document, with its resources inlined.
 *
 * Supersedes the old collectSameOriginCss + buildExternalCss pair. Those split on readability
 * and only the unreadable half got its fonts inlined, which is exactly backwards from what a
 * self-hosted font needs.
 */
export async function collectCss(doc: Document, cache: ResourceCache): Promise<string> {
  const parts: string[] = []
  for (const sheet of Array.from(doc.styleSheets)) {
    parts.push(await sheetText(sheet, doc, cache, 0))
  }
  return parts.join('\n')
}
