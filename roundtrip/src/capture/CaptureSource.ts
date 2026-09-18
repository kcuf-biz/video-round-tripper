export type { CaptureSource } from '../types.ts'
export { createForeignObjectSource, type ForeignObjectOptions } from './foreignObjectSource.ts'
export {
  createResourceCache,
  collectSameOriginCss,
  buildExternalCss,
  syncFormState,
  type ResourceCache,
} from './inlineResources.ts'
