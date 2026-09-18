import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Dedicated port, not 5173/5174 — those collide with the other Vite projects on this
    // machine. strictPort so a collision fails loudly instead of silently moving.
    port: 5394,
    strictPort: true,
    host: '127.0.0.1',
  },
  optimizeDeps: {
    // The roundtrip package ships TypeScript source with no build step (the a source-only workspace
    // pattern). Pre-bundling it would try to treat it as a built dependency.
    exclude: ['@video-round-tripper/roundtrip'],
  },
})
