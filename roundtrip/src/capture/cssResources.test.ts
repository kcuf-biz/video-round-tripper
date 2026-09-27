import { describe, expect, it } from 'vitest'
import {
  bytesToBase64,
  collectCssUrls,
  extractImports,
  mimeFor,
  resolveCssUrl,
  rewriteCssUrls,
  stripImports,
} from './cssResources.ts'

/**
 * Only the pure string half is tested here — the fetching half needs a document and a network
 * and is verified in a real browser, per vitest.config.ts. These are the transforms where a
 * silent mistake produces a page that renders in the wrong font rather than an error.
 */

const SHEET = 'https://cdn.example.com/a/b/site.css'

describe('resolveCssUrl', () => {
  it('resolves relative to the SHEET, which is not the document', () => {
    // The whole reason a self-hosted @font-face broke: ../fonts/x.woff2 under /a/b/site.css is
    // /a/fonts/x.woff2, and resolving it against the page instead gives a 404.
    expect(resolveCssUrl('../fonts/x.woff2', SHEET)).toBe('https://cdn.example.com/a/fonts/x.woff2')
    expect(resolveCssUrl('./t.png', SHEET)).toBe('https://cdn.example.com/a/b/t.png')
    expect(resolveCssUrl('/root.png', SHEET)).toBe('https://cdn.example.com/root.png')
  })

  it('leaves an already-absolute url alone, so it does not matter whether cssText absolutised it', () => {
    const abs = 'https://other.example/x.woff2'
    expect(resolveCssUrl(abs, SHEET)).toBe(abs)
  })

  it('returns null for anything that carries its own bytes or cannot be fetched', () => {
    expect(resolveCssUrl('data:image/png;base64,AAAA', SHEET)).toBeNull()
    expect(resolveCssUrl('blob:https://x/y', SHEET)).toBeNull()
    expect(resolveCssUrl('', SHEET)).toBeNull()
  })

  it('never resolves a fragment-only reference, which points INTO the document (#63)', () => {
    // Resolved, url(#g) became https://cdn.example.com/a/b/site.css#g -- a url into another
    // document -- and SVG paints a failed paint server as `none`, silently.
    expect(resolveCssUrl('#mark-row', SHEET)).toBeNull()
  })
})

describe('rewriteCssUrls', () => {
  const swap = (css: string) => rewriteCssUrls(css, SHEET, () => 'data:font/woff2;base64,QQ==')

  it('handles bare, single-quoted and double-quoted forms, and whitespace', () => {
    expect(swap('src:url(a.woff2)')).toBe('src:url("data:font/woff2;base64,QQ==")')
    expect(swap("src:url('a.woff2')")).toBe('src:url("data:font/woff2;base64,QQ==")')
    expect(swap('src:url( "a.woff2" )')).toBe('src:url("data:font/woff2;base64,QQ==")')
  })

  it('rewrites every occurrence in a rule, not just the first', () => {
    const out = swap('src:url(a.woff2) format("woff2"),url(b.woff) format("woff")')
    expect(out.match(/data:font/g)).toHaveLength(2)
  })

  it('leaves a url the map declines BYTE-IDENTICAL, so the font falls back instead of the rule breaking', () => {
    const css = "@font-face{src:url('../f/x.woff2') format('woff2')}"
    expect(rewriteCssUrls(css, SHEET, () => null)).toBe(css)
  })

  it('leaves data: URIs alone rather than round-tripping them through a fetch', () => {
    const css = 'background:url(data:image/gif;base64,R0lGOD)'
    expect(rewriteCssUrls(css, SHEET, () => 'data:nope')).toBe(css)
  })

  it('leaves every fragment reference byte-identical: paint servers, masks, filters, clip-paths', () => {
    const css = `.k{fill:url(#mark-row);mask:url('#m');filter:url("#f");clip-path:url( #c )}`
    expect(rewriteCssUrls(css, SHEET, () => 'data:nope')).toBe(css)
    expect(collectCssUrls(css, SHEET)).toEqual([])
  })

  it('escapes quotes and backslashes it puts back into the sheet', () => {
    expect(rewriteCssUrls('url(a.png)', SHEET, () => 'x"y\\z')).toBe('url("x\\"y\\\\z")')
  })

  it('survives an escaped delimiter inside the token', () => {
    expect(collectCssUrls('url(we\\)ird.png)', SHEET)).toEqual(['https://cdn.example.com/a/b/we)ird.png'])
  })
})

describe('collectCssUrls', () => {
  it('deduplicates, so one URL is fetched once however often it is referenced', () => {
    const css = 'a{background:url(t.png)}b{background:url(./t.png)}c{background:url(t.png)}'
    expect(collectCssUrls(css, SHEET)).toEqual(['https://cdn.example.com/a/b/t.png'])
  })
})

describe('extractImports', () => {
  it('reads both the url() and the bare-string form', () => {
    expect(extractImports('@import url("a.css");', SHEET)[0]?.absolute).toBe(
      'https://cdn.example.com/a/b/a.css',
    )
    expect(extractImports("@import 'b.css';", SHEET)[0]?.absolute).toBe(
      'https://cdn.example.com/a/b/b.css',
    )
  })

  it('reads the target past a media query, layer() or supports() suffix', () => {
    const css = `
      @import url(c.css) screen and (min-width: 100px);
      @import url("d.css") layer(base) supports(display: grid);
    `
    expect(extractImports(css, SHEET).map((i) => i.href)).toEqual(['c.css', 'd.css'])
  })

  it('ignores an @import it cannot parse rather than guessing', () => {
    expect(extractImports('@import ;', SHEET)).toEqual([])
  })

  it('stripImports removes exactly the rules it found', () => {
    expect(stripImports('@import url(a.css);body{color:red}')).toBe('body{color:red}')
  })
})

describe('mimeFor', () => {
  it('prefers what the server sent', () => {
    expect(mimeFor('/x', 'font/woff2; charset=binary')).toBe('font/woff2')
  })

  it('falls back to the extension when the server is unhelpful', () => {
    // The first cut hardcoded font/woff2 for every resource it inlined.
    expect(mimeFor('/a/b.png?v=2', 'application/octet-stream')).toBe('image/png')
    expect(mimeFor('/a/b.woff2', null)).toBe('font/woff2')
    expect(mimeFor('/a/b.unknown', null)).toBe('application/octet-stream')
  })
})

describe('bytesToBase64', () => {
  it('matches btoa over a chunk boundary', () => {
    const n = 8192 * 2 + 5
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i++) bytes[i] = i % 251
    let plain = ''
    for (let i = 0; i < n; i++) plain += String.fromCharCode(bytes[i]!)
    expect(bytesToBase64(bytes)).toBe(btoa(plain))
  })
})
