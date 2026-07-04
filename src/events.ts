// Ocean event bus — leaf module.
// No imports from loom/ or runtime/. Both the renderer and sound system subscribe here.

export type OceanEvent =
  | { type: 'weave'; sourceId: string; targetId: string; family: string }
  | { type: 'emergence'; voiceIds: string[]; familyNames: string[] }
  | { type: 'loom-enter'; seedId: string }
  | { type: 'loom-exit' }
  | { type: 'warmth-update'; familyWarmth: Record<string, number> }

type Listener = (event: OceanEvent) => void

const listeners: Listener[] = []

export function onOceanEvent(listener: Listener): () => void {
  listeners.push(listener)
  return () => {
    const i = listeners.indexOf(listener)
    if (i >= 0) listeners.splice(i, 1)
  }
}

export function emitOceanEvent(event: OceanEvent): void {
  for (const listener of listeners) listener(event)
}
