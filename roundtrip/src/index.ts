/**
 * Public surface. Kept deliberately small — everything else is an implementation detail and
 * is free to change.
 */
export { RoundTrip } from './RoundTrip.tsx'
export type {
  RoundTripProps,
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

// The pure bits, exported because they are useful to test against and to reason about.
export { quantizerFor, encodeOptionsFor, familyOf } from './quantizer.ts'
export { createMoshFilter, type MoshFilter } from './mosh.ts'
export { encodeSize, createPacer } from './frameBudget.ts'
