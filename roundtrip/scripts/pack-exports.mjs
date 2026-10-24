/**
 * Swap `exports` for `distExports` around `npm pack`, and swap it back.
 *
 * WHY THIS EXISTS. The package has to have it both ways. `exports` must point at `./src/*.ts`
 * so the demo workspace consumes the TypeScript source directly with no build step — that is
 * the whole a source-only workspace pattern this repo is built on, and losing it means a rebuild
 * between every edit and every reload. A tarball, though, contains only `dist` (see `files`),
 * so an `exports` map pointing at `src` resolves to nothing at all for a consumer.
 *
 * `publishConfig` is npm's answer to exactly this, and VERIFIED HERE IT DOES NOT COVER
 * `exports`: packed with npm 11 / node 24, the tarball's package.json still carried the `src`
 * map verbatim. npm only overrides a fixed set of fields (registry, access, tag, bin, ...).
 * So the swap is done by hand, in prepack, and undone in postpack. The dist map lives in a
 * top-level `distExports` (npm ignores unknown top-level fields) rather than in publishConfig,
 * where npm 11 warns it is an unknown config that "will stop working in the next major".
 *
 * The README rides along the same way: npm shows the README in the PACKAGE folder, and the one
 * worth showing is the repo's, so `apply` copies it in and `restore` removes the copy (it is
 * git-ignored, so an interrupted pack leaves nothing to commit by mistake).
 *
 * The original is saved next to package.json rather than reconstructed, so an interrupted pack
 * leaves something to restore from instead of a guess. `restore` is a no-op when it is absent.
 */
import { readFile, writeFile, rm, access, copyFile } from 'node:fs/promises'

const PKG = new URL('../package.json', import.meta.url)
const BACKUP = new URL('../package.json.packbak', import.meta.url)
const README = new URL('../README.md', import.meta.url)
const REPO_README = new URL('../../README.md', import.meta.url)
const mode = process.argv[2]

if (mode === 'apply') {
  const raw = await readFile(PKG, 'utf8')
  const pkg = JSON.parse(raw)
  if (!pkg.distExports) {
    throw new Error('distExports is missing; nothing to pack against')
  }
  await writeFile(BACKUP, raw)
  pkg.exports = pkg.distExports
  delete pkg.distExports
  await writeFile(PKG, JSON.stringify(pkg, null, 2) + '\n')
  await copyFile(REPO_README, README)
  console.log('pack-exports: exports -> dist, README copied in')
} else if (mode === 'restore') {
  await rm(README, { force: true })
  try {
    await access(BACKUP)
  } catch {
    console.log('pack-exports: nothing to restore')
    process.exit(0)
  }
  await writeFile(PKG, await readFile(BACKUP, 'utf8'))
  await rm(BACKUP)
  console.log('pack-exports: exports -> src')
} else {
  throw new Error(`usage: pack-exports.mjs apply|restore (got ${mode})`)
}
