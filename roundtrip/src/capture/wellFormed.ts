/**
 * Make the clone WELL-FORMED XML, because one ill-formed node loses the whole frame.
 *
 * The clone is an HTML tree, but it is serialized with XMLSerializer and decoded as an SVG
 * image — i.e. by an XML parser, which does not recover. XMLSerializer does not validate what
 * it writes, so anything the HTML parser tolerates and XML forbids goes straight through, and
 * `img.decode()` then fails with "The source image cannot be decoded." and nothing else. Not a
 * missing element: an empty frame, pointing nowhere near the cause.
 *
 * Found by use (backlog #62): kcuf's first mount produced no frames at all because of a single
 * `<!-- ---- section ---- -->`. Checked in Chrome 150 while fixing it, every one of these kills
 * the frame the same way:
 *
 *   `--` inside a comment        "Double hyphen within comment"
 *   `@click` (Alpine)            "error parsing attribute name"
 *   `:class` (Alpine, petite-vue) "Failed to parse QName ':class'"
 *   `x-on:click`, `hx-on:click`  "Namespace prefix x-on for click on p is not defined"
 *   U+0001 in a text node        "PCDATA invalid Char value 1"
 *
 * The attribute cases matter more than the comment: Alpine and htmx leave their directives in
 * the live DOM on purpose, so a drop-anywhere component pasted onto such a page would never
 * have produced one frame.
 *
 * Nothing removed here contributes to a rendered frame. Comments never paint; a directive
 * attribute could only matter to an attribute selector written against its escaped name.
 * `xlink:href` set through setAttribute (no namespace) is the one exception worth keeping, so it
 * becomes SVG 2's plain `href` instead of being dropped.
 */

/*
 * XML 1.0 (5th ed.) NameStartChar / NameChar, minus ':' — an attribute with no namespace and a
 * colon in its name serializes as a prefix the document never declares, which is also fatal.
 */
const NAME_START =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD'
const NAME_CHAR = NAME_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040'
const NCNAME = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`)

/** Characters XML 1.0 forbids anywhere, even escaped. Tab, LF and CR are allowed. */
const INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

/** Whether an attribute with NO namespace serializes to something an XML parser accepts. */
export function isXmlAttributeName(name: string): boolean {
  return NCNAME.test(name)
}

export function stripInvalidXmlChars(s: string): string {
  return s.replace(INVALID_CHARS, '')
}

/** Mutates `root` in place. Returns how many nodes/attributes it had to touch. */
export function makeWellFormed(root: Element): number {
  let touched = 0
  const doc = root.ownerDocument
  // NodeFilter.SHOW_ELEMENT | SHOW_TEXT | SHOW_COMMENT
  const walker = doc.createTreeWalker(root, 0x1 | 0x4 | 0x80)
  const comments: Comment[] = []

  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === 8) {
      comments.push(n as Comment) // removing mid-walk would strand the walker
    } else if (n.nodeType === 3) {
      const t = n as Text
      INVALID_CHARS.lastIndex = 0
      if (INVALID_CHARS.test(t.data)) {
        t.data = stripInvalidXmlChars(t.data)
        touched++
      }
    } else {
      const el = n as Element
      // Most elements carry no attributes worth a second look; iterate a snapshot because
      // removing from the live NamedNodeMap shifts it.
      for (const attr of Array.from(el.attributes)) {
        if (attr.namespaceURI === null && !isXmlAttributeName(attr.name)) {
          const keepAs = attr.name.toLowerCase() === 'xlink:href' && !el.hasAttribute('href') ? 'href' : null
          el.removeAttribute(attr.name)
          if (keepAs) el.setAttribute(keepAs, attr.value)
          touched++
        } else {
          INVALID_CHARS.lastIndex = 0
          if (INVALID_CHARS.test(attr.value)) {
            attr.value = stripInvalidXmlChars(attr.value)
            touched++
          }
        }
      }
    }
  }

  for (const c of comments) c.remove()
  return touched + comments.length
}

/**
 * The CSS goes into a CDATA section, which ends at the first `]]>` — legal inside a CSS string
 * (`content: "]]>"`), fatal to the frame. Splitting the terminator across two sections is the
 * standard escape.
 */
export function escapeCdata(s: string): string {
  return s.replace(/]]>/g, ']]]]><![CDATA[>')
}

/**
 * Turn an opaque decode failure into the parser's own account of it.
 *
 * Only runs on the failure path, so it costs nothing per frame. Any future well-formedness
 * hole this file does not know about yet then reports as "line 1, column 48213: Double hyphen
 * within comment, near `<!-- ---- sec`" instead of as a black canvas.
 */
export function explainUndecodable(svg: string): string | null {
  if (typeof DOMParser === 'undefined') return null
  const err = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror')
  if (!err) return null
  const text = (err.textContent ?? '').replace(/\s+/g, ' ').trim()
  const at = /line (\d+) at column (\d+):\s*([^]*?)(?:\s*Below is a rendering.*)?$/.exec(text)
  if (!at) return text.slice(0, 200)
  const line = Number(at[1])
  const col = Number(at[2])
  const src = svg.split('\n')[line - 1] ?? ''
  const near = src.slice(Math.max(0, col - 40), col + 20)
  return `${at[3]!.trim()} (line ${line}, column ${col}, near \`${near}\`)`
}
