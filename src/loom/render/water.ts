// Water on the sheet. Touch wets, time dries: wet paint moves and spreads, dry paint
// holds still and crisp. This file owns the water; the bands (wash.ts) and the text
// only ask it how wet things are.
//
// PLACEHOLDER until the water field lands: a current is as wet as its lens is open.
// The real answer lingers after the lens leaves and dries over some seconds.

import type { Thread } from '../types.js'

/** How wet this current is now, 0 (dry: thin, still, crisp) to 1 (under standing water). */
export function wetnessOf(thread: Thread): number {
  return Math.max(0, Math.min(1, thread.proximity))
}
