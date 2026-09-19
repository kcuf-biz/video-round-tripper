import { defineConfig } from 'vite'

/**
 * The paste-into-someone-else's-page bundle: one self-contained file exposing `RoundTripCore`.
 *
 * Separate from vite.config.ts because IIFE is single-entry only — Rollup cannot emit it from
 * the multi-entry ESM build — and `emptyOutDir: false` so it lands beside that build's output
 * instead of deleting it. Build order therefore matters: ESM first, IIFE second.
 *
 * Entry is `core`, never `index`: this file has to run where there is no bundler and no React.
 */
export default defineConfig({
  // Vite's root defaults to the process CWD, and these are run from the repo root by the
  // workspace scripts — without this the entry paths resolve against the wrong directory and
  // Rollup reports "Could not resolve entry module".
  //
  // Derived from import.meta.url rather than node:url's fileURLToPath so this file needs no
  // @types/node: the roundtrip workspace's `types` is scoped to @types/dom-webcodecs, and
  // widening it to pull in Node's globals for two build configs is a bad trade. POSIX-only,
  // which this repo already is.
  root: decodeURIComponent(new URL('.', import.meta.url).pathname),
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: 'src/core/index.ts',
      name: 'RoundTripCore',
      formats: ['iife'],
      fileName: () => 'roundtrip.iife.js',
    },
  },
})
