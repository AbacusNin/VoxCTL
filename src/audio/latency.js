import { ANALYSIS_MS } from './audio-engine.js';

// Voice-to-sound delay estimated from what the browser reports, plus the
// pitch window. It is not a measured round trip. A value the browser does
// not report is null and left out of the total, which is then marked partial
// rather than silently counting it as 0.

// A browser value counts only if it is a finite, non-negative number of
// seconds.
function reported(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function estimateLatency({ baseLatency, outputLatency, trackLatency, sampleRate, windowSize, cadenceMs } = {}) {
  // The newest sample in a window is fresh and the oldest is a whole window
  // old, so the detector sees the voice half a window late on average.
  const window = Number.isFinite(windowSize) && windowSize > 0 && Number.isFinite(sampleRate) && sampleRate > 0
    ? (windowSize / sampleRate) * 500 : null;
  const cadence = Number.isFinite(cadenceMs) && cadenceMs > 0 ? Math.min(cadenceMs, 1000) / 2 : null;
  const parts = [
    { key: 'input', label: 'Mic input (track)', ms: reported(trackLatency) },
    { key: 'window', label: 'Pitch window (half)', ms: window },
    { key: 'cadence', label: 'Analysis wait (half cadence)', ms: cadence },
    { key: 'base', label: 'Audio context', ms: reported(baseLatency) },
    { key: 'output', label: 'Output device', ms: reported(outputLatency) }
  ];
  const totalMs = parts.reduce((sum, p) => sum + (p.ms ?? 0), 0);
  return { parts, totalMs, partial: parts.some(p => p.ms === null) };
}

// Seconds a sung take lags the grid it was sung to: the click reaches the
// ear late by the output path, and the voice reaches the recorder late by
// the input path and the analysis. Each DynamicsCompressor on the heard path
// adds about 6 ms (measured in Chrome). Null when the browser reports none
// of its own latencies, so a caller can tell a guess from nothing.
export function estimateRoundTripSeconds({ baseLatency, outputLatency, trackLatency, sampleRate, windowSize, analysisMs = ANALYSIS_MS, compressors = 1 } = {}) {
  const browser = [outputLatency, baseLatency, trackLatency].map(reported).filter(ms => ms !== null);
  if (!browser.length) return null;
  const analysis = Number.isFinite(windowSize) && windowSize > 0 && Number.isFinite(sampleRate) && sampleRate > 0
    ? windowSize / 2 / sampleRate : 0;
  const hop = Number.isFinite(analysisMs) && analysisMs > 0 ? analysisMs / 2000 : 0;
  const comp = Number.isFinite(compressors) && compressors > 0 ? compressors * 0.006 : 0;
  return browser.reduce((sum, ms) => sum + ms / 1000, 0) + analysis + hop + comp;
}
