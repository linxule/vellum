export interface WitnessReporter {
  /** Call once per frame. Handles dwell tracking + phantom gating. */
  checkWitness(): void
}

/**
 * Witness reporter. `endpoint` is the full fetch URL (e.g., '/api/witness'
 * for standalone or `${BASE_URL}/api/witness` for ext-app, where BASE_URL
 * is the sentinel-rewritten origin).
 *
 * `getLoomState` and `isPhantomActive` are injected rather than imported
 * so this module doesn't reach across to the loom barrel. `isLiveFn`
 * allows the reporter to skip fetches in fallback mode.
 */
export function createWitnessReporter(opts: {
  endpoint: string
  getLoomState: () => { families: string[]; [k: string]: unknown }
  isPhantomActive: () => boolean
  isLiveFn: () => boolean
}): WitnessReporter {
  const { endpoint, getLoomState, isPhantomActive, isLiveFn } = opts

  let dwellStart = 0
  let dwellFamilies: string[] = []
  let prevTouchedFamiliesKey = ''
  let prevPhantom = false

  function onThreadFocus(families: string[]) {
    dwellStart = Date.now()
    dwellFamilies = families
  }

  function onThreadRelease() {
    if (!isLiveFn()) return
    if (dwellStart && dwellFamilies.length > 0) {
      const dwell_s = (Date.now() - dwellStart) / 1000
      if (dwell_s > 1) {
        fetch(endpoint, {
          method: 'POST',
          body: JSON.stringify({ families: dwellFamilies, dwell_s }),
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {})
      }
    }
    dwellStart = 0
    dwellFamilies = []
  }

  function checkWitness() {
    const phantomActive = isPhantomActive()
    if (phantomActive) {
      if (!prevPhantom && prevTouchedFamiliesKey) {
        onThreadRelease()
        prevTouchedFamiliesKey = ''
      }
      prevPhantom = true
      return
    }
    prevPhantom = false
    const st = getLoomState()
    const currentFamilies = st.families
    const currentFamiliesKey = [...currentFamilies].sort().join(',')
    if (currentFamiliesKey && currentFamiliesKey !== prevTouchedFamiliesKey) {
      if (prevTouchedFamiliesKey) onThreadRelease()
      onThreadFocus(currentFamilies)
    } else if (!currentFamiliesKey && prevTouchedFamiliesKey) {
      onThreadRelease()
    }
    prevTouchedFamiliesKey = currentFamiliesKey
  }

  return { checkWitness }
}
