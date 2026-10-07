import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Dedicated port, not 5173/5174 — those collide with the other Vite projects on this
    // machine. strictPort so a collision fails loudly instead of silently moving.
    port: 5394,
    strictPort: true,
    // Stays bound to loopback even when reached over the tailnet: `tailscale serve`
    // terminates TLS and proxies in, so the dev server itself is never on a network
    // interface. That also supplies the SECURE CONTEXT that WebCodecs requires — over plain
    // http:// to a tailnet IP, VideoEncoder is simply undefined and the piece cannot run.
    host: '127.0.0.1',
    // Vite rejects requests whose Host header it does not recognise (DNS-rebinding guard).
    // Scoped to this tailnet's domain rather than `true`, which would allow any host.
    allowedHosts: ['.ts.net'],
  },
  build: {
    rollupOptions: {
      /*
       * Multi-page: /hostile/ is the acid test for the capture seam — one specimen per thing
       * that degrades silently — and it has to be a real page, not a route, because part of
       * what it tests is a <link> stylesheet whose href sits one directory above the document.
       *
       * new URL() rather than node:path so this stays free of @types/node.
       */
      input: {
        main: new URL('./index.html', import.meta.url).pathname,
        hostile: new URL('./hostile/index.html', import.meta.url).pathname,
        // #72: all four codec families side by side at one coarseness, for fitting the floors.
        compare: new URL('./compare/index.html', import.meta.url).pathname,
      },
    },
  },
  optimizeDeps: {
    // The roundtrip package ships TypeScript source with no build step (the a source-only workspace
    // pattern). Pre-bundling it would try to treat it as a built dependency.
    exclude: ['@kcuf.biz/video-round-tripper'],
  },
})
