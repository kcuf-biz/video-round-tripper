import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // A dedicated port, not Vite's default 5173, so it does not collide with other Vite
    // projects. strictPort so a collision fails loudly instead of silently moving.
    port: 5394,
    strictPort: true,
    // Stays bound to loopback even when viewed from another device: put something that
    // terminates TLS in front of it (`npm run serve:tailnet` uses `tailscale serve`), so the
    // dev server itself is never on a network interface. That also supplies the SECURE
    // CONTEXT that WebCodecs requires — over plain http:// to a LAN address, VideoEncoder is
    // simply undefined and the piece cannot run.
    host: '127.0.0.1',
    // Vite rejects requests whose Host header it does not recognise (DNS-rebinding guard).
    // Add your own HTTPS hostname here; `true` would allow any host. `.ts.net` covers
    // Tailscale: such a name only resolves inside its own tailnet (or to Tailscale's Funnel
    // servers), so no outside page can rebind one to loopback.
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
        // How video survives capture: the composited and embedded paths, and iOS Safari's limit.
        video: new URL('./video/index.html', import.meta.url).pathname,
      },
    },
  },
  optimizeDeps: {
    // The roundtrip package ships TypeScript source with no build step (a
    // source-only workspace package). Pre-bundling it would try to treat it as a built dependency.
    exclude: ['@kcuf.biz/video-round-tripper'],
  },
})
