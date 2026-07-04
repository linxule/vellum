// src/audio/strudel.d.ts
// Ambient type declarations for @strudel/web@1.3.0 window globals.
// After the <script> loads, globals land on window.strudel (1017 keys).
// After initStrudel(), they're also copied to window directly.
// Code uses (window as any) everywhere — these types are documentation only.

interface StrudelGlobals {
  initStrudel?: (opts?: {
    prebake?: () => Promise<void>
  }) => Promise<void>
  evaluate?: (code: string, autoStart?: boolean) => void
  hush?: () => void
  samples?: (url: string) => Promise<void>
  getAudioContext?: () => AudioContext
  getSuperdoughAudioController?: () => {
    output?: {
      destinationGain?: GainNode
    }
  }
}

interface Window {
  strudel?: StrudelGlobals
  // Post-initStrudel(), these are also available directly on window
  initStrudel?: StrudelGlobals['initStrudel']
  evaluate?: StrudelGlobals['evaluate']
  hush?: StrudelGlobals['hush']
  getAudioContext?: StrudelGlobals['getAudioContext']
  getSuperdoughAudioController?: StrudelGlobals['getSuperdoughAudioController']
}
