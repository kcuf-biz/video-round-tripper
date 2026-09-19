/**
 * Rewrite `./x.ts` -> `./x.js` in the emitted declaration files.
 *
 * WHY THIS EXISTS. The package's source imports carry explicit `.ts`/`.tsx` extensions — that
 * is the source-only pattern the demo workspace depends on, and `allowImportingTsExtensions`
 * is what permits it. TypeScript's `rewriteRelativeImportExtensions` (5.7+) is supposed to fix
 * those up on the way out, and it does: in the JAVASCRIPT. Verified against tsc 5.9.3 with a
 * two-file repro — the emitted `.js` says `from "./a.js"` and the emitted `.d.ts` still says
 * `from './a.ts'`. Vite emits our JavaScript, so declarations are the only thing tsc produces
 * for us, which puts the whole package squarely in the one case the flag misses. A consumer
 * would then be pointed at `./types.ts`, which is not in the tarball at all.
 *
 * Only RELATIVE specifiers are touched. A bare specifier that happens to end in `.ts` is a
 * package name and must be left alone.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIST = new URL('../dist/', import.meta.url).pathname

/** `from './x.ts'`, `import('./x.ts')`, and the `sources` array of a .d.ts.map. */
const SPECIFIER = /(['"])(\.{1,2}\/[^'"]*?)\.(tsx|ts)\1/g

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else yield p
  }
}

let changed = 0
for await (const file of walk(DIST)) {
  if (!file.endsWith('.d.ts')) continue
  const before = await readFile(file, 'utf8')
  const after = before.replace(SPECIFIER, '$1$2.js$1')
  if (after !== before) {
    await writeFile(file, after)
    changed++
  }
}
console.log(`dts-extensions: rewrote .ts specifiers in ${changed} declaration file(s)`)
