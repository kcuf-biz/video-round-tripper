export type { CaptureSource, CaptureReport } from '../types.ts'
export { createForeignObjectSource, type ForeignObjectOptions } from './foreignObjectSource.ts'
export {
  createResourceCache,
  prepareClone,
  syncFormState,
  type ResourceCache,
  type ResourceStats,
  type PreparedClone,
} from './inlineResources.ts'
export { collectCss, inlineCssUrls } from './cssResources.ts'
export { syncScrollState } from './positioning.ts'
export { pairElements, pairDescendants, type ElementPair } from './pairs.ts'
export { rewriteSelector } from './shadowDom.ts'
