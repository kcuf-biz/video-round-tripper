export type { CaptureSource, CaptureReport } from '../types.ts'
export { createForeignObjectSource, type ForeignObjectOptions } from './foreignObjectSource.ts'
export {
  createResourceCache,
  prepareClone,
  syncFormState,
  syncScrollState,
  type ResourceCache,
  type ResourceStats,
  type PreparedClone,
} from './inlineResources.ts'
export { collectCss, inlineCssUrls } from './cssResources.ts'
