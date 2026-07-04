export { attachInputHandlers } from './input'
export { setupCanvas, type CanvasBundle } from './canvas'
export { createWitnessReporter, type WitnessReporter } from './witness'
export {
  computeNewVoiceInfo,
  applyResonanceFromNewVoices,
  fetchStateWithTimeout,
  type NewVoiceInfo,
} from './poll-core'
export { updateMouseVelocity, scheduleNextFrame, clearScheduledFrame } from './frame'
