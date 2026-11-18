import { expect, test } from 'bun:test'
import { OCEAN } from '../../worker/src/contract'
import { SUNKEN_DEPTH } from '../../src/loom/types'

// The worker decides which voices are "sunken" (and tops each current up with them);
// the renderer decides which voices to paint dimmer. Two packages, one line.
test('the renderer dims exactly the voices the worker calls sunken', () => {
  expect(SUNKEN_DEPTH).toBe(OCEAN.sunkenDepth)
})
