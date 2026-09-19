/**
 * What the capture had to give up on, so the degradation is visible rather than silent.
 *
 * Every entry here is something that CANNOT be round-tripped faithfully and is therefore
 * standing in as a flat grey block or a fallback font. The piece is made of things rendering
 * wrong on purpose, which is exactly why the things rendering wrong by ACCIDENT have to be
 * countable — otherwise the only way to tell them apart is to already know what the page was
 * supposed to look like.
 */
import type { CaptureReport } from '../types.ts'

export type { CaptureReport }

export function emptyReport(): CaptureReport {
  return { blockedImages: 0, missingFonts: 0, closedShadowRoots: 0, iframes: 0 }
}
