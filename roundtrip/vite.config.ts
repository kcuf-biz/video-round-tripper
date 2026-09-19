import { defineConfig } from 'vite'

/**
 * Library build. Two ESM entries, because they serve two different consumers:
 *
 *  - `index` is the React surface (the component plus everything else).
 *  - `core` is framework-free, so a plain page — or an Astro site that does not want a React
 *    island just to run this — pays for no React at all.
 *
 * The package's `exports` field deliberately still points at `src`, so the demo workspace keeps
 * its no-build dev loop; `publishConfig.exports` swaps in this output at pack time. See
 * roundtrip/package.json.
 *
 * The IIFE lives in its own config (vite.iife.config.ts): IIFE is a single-entry format and
 * cannot be produced from this multi-entry build.
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
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    lib: {
      entry: {
        index: 'src/index.ts',
        core: 'src/core/index.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      // Peer, and optional: nothing reachable from ./core imports any of these.
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
  },
})
