/**
 * The framework-free entry point.
 *
 * Everything reachable from here must be React-free — this is what the `./core` export and the
 * IIFE bundle (global `RoundTripCore`) are built from, and the IIFE exists precisely so the
 * piece can be pasted into a page that has no bundler and no React. The build checks this by
 * grepping the output; the discipline is "do not import ../RoundTrip.tsx or ../index.ts from
 * anything under core/".
 */
export { createRoundTrip, prefersReducedMotion } from './createRoundTrip.ts'
export type {
  RoundTripController,
  RoundTripCoreOptions,
  RoundTripDials,
  RoundTripStatus,
} from './createRoundTrip.ts'
export { ensureStyles, ROUNDTRIP_CSS } from './styles.ts'
export { mountRoundTrip, type MountOptions, type MountedRoundTrip } from '../mount.ts'

export type {
  CaptureReport,
  CaptureSource,
  CodecChoice,
  CodecFamily,
  MoshConfig,
} from '../types.ts'

// Swap or wrap the capture strategy.
export { createForeignObjectSource, type ForeignObjectOptions } from '../capture/foreignObjectSource.ts'
export { createResourceCache, type ResourceCache } from '../capture/inlineResources.ts'

// Probe the device yourself (e.g. to show the user what it picked).
export { probeCodec, CODEC_PREFERENCE } from '../codec/probe.ts'

// Codec families: the strings each expands to (level derived from coded size) and the
// starting dials each one gets when the caller does not say. CODEC_PREFERENCE, above, is the
// family order and lives here too.
export {
  CODEC_DEFAULTS,
  codecStringsFor,
  isCodecFamily,
  resolveDials,
  type CodecDials,
} from '../codecs.ts'

// The pure bits, exported because they are useful to test against and to reason about.
export { quantizerFor, encodeOptionsFor, familyOf } from '../quantizer.ts'
export { createMoshFilter, type MoshFilter } from '../mosh.ts'
export { encodeSize, createPacer } from '../frameBudget.ts'
