import { idleStats, type RoundTripController } from './createRoundTrip.ts'

/**
 * The read-only half of a controller, as a handle that outlives any one controller.
 *
 * Both entry points rebuild their controller whenever a construction-time option changes (codec,
 * size, capture mode) or reduced motion flips, and hold none at all while bypassed. A caller
 * that kept the controller itself would be holding a disposed one after the first rebuild; this
 * reads whichever is current at CALL time instead, and answers as idle when there is none.
 *
 * tune() is deliberately not here. The mount handle adds it, because there the handle is the
 * only way in; on <RoundTrip> the dial props are the tuning surface, and an imperative tune
 * would be silently overwritten the next time any dial prop changed.
 */
export interface RoundTripHandle {
  /** See RoundTripController.report — `undefined` while there is nothing to report on. */
  report: RoundTripController['report']
  /** See RoundTripController.stats — idle (zeros, nulls) while there is no controller. */
  stats: RoundTripController['stats']
}

export function readHandle(current: () => RoundTripController | null): RoundTripHandle {
  return {
    report: () => current()?.report(),
    stats: () => current()?.stats() ?? idleStats(),
  }
}
