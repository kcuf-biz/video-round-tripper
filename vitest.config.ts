import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    // Only the pure modules are unit-tested. Anything touching WebCodecs, canvas or the DOM
    // is verified in a real browser instead — see CONTRIBUTING.md. jsdom would happily pass code
    // that cannot work, which is worse than no test.
    include: ['roundtrip/src/**/*.test.ts'],
  },
})
