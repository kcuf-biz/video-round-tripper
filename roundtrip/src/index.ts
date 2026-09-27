/**
 * Public surface. Kept deliberately small — everything else is an implementation detail and
 * is free to change.
 */
export { RoundTrip, type RoundTripProps } from './RoundTrip.tsx'

// The framework-free controller and the vanilla mount. The React component is a thin wrapper
// over the first of these; the second is what a plain page (or the IIFE bundle) uses.
export { createRoundTrip, prefersReducedMotion } from './core/createRoundTrip.ts'
export type {
  RoundTripController,
  RoundTripCoreOptions,
  RoundTripDials,
  RoundTripStatus,
} from './core/createRoundTrip.ts'
export { mountRoundTrip, type MountOptions, type MountedRoundTrip } from './mount.ts'
export { ensureStyles, ROUNDTRIP_CSS } from './core/styles.ts'
export type {
  CaptureReport,
  CaptureSource,
  CodecChoice,
  CodecFamily,
  MoshConfig,
} from './types.ts'

// Swap or wrap the capture strategy.
export { createForeignObjectSource, type ForeignObjectOptions } from './capture/foreignObjectSource.ts'
export { createResourceCache, type ResourceCache } from './capture/inlineResources.ts'

// Probe the device yourself (e.g. to show the user what it picked).
export { probeCodec, CODEC_PREFERENCE } from './codec/probe.ts'

// Codec families: the strings each expands to (level derived from coded size) and the
// starting dials each one gets when the caller does not say. CODEC_PREFERENCE, above, is the
// family order and lives here too.
export {
  CODEC_DEFAULTS,
  codecStringsFor,
  isCodecFamily,
  resolveDials,
  type CodecDials,
} from './codecs.ts'

// The pure bits, exported because they are useful to test against and to reason about.
export { quantizerFor, encodeOptionsFor, familyOf } from './quantizer.ts'
export { createMoshFilter, type MoshFilter } from './mosh.ts'
export { contentSize, encodeSize, createPacer } from './frameBudget.ts'
