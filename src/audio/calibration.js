// The storage key keeps its v0.2 suffix on purpose: renaming it would drop
// every saved room baseline.
export class CalibrationEngine {
  constructor({ storageKey = 'voxctl.calibration.v0.2' } = {}) {
    this.storageKey = storageKey;
    this.samples = [];
    this.active = false;
    this.resolve = null;
    this.timer = null;
  }

  // Stored values pass through the same bounds finish() produces, so a
  // tampered entry such as a 1e9 gate cannot silence all input.
  load() {
    try {
      const value = JSON.parse(localStorage.getItem(this.storageKey));
      if (!value || !inRange(value.noiseFloor, 0.001, 0.05) || !inRange(value.noiseGate, 0.004, 0.05)) return null;
      return { noiseFloor: value.noiseFloor, noiseGate: value.noiseGate, calibratedAt: String(value.calibratedAt || '').slice(0, 40) };
    } catch {
      return null;
    }
  }

  start(durationMs = 1800) {
    if (this.active) return Promise.reject(new Error('Calibration already running.'));
    this.samples = [];
    this.active = true;
    return new Promise(resolve => {
      this.resolve = resolve;
      this.timer = setTimeout(() => this.finish(), durationMs);
    });
  }

  ingest(signal) {
    if (this.active && Number.isFinite(signal?.rms)) this.samples.push(signal.rms);
  }

  finish() {
    if (!this.active) return null;
    clearTimeout(this.timer);
    this.active = false;
    const values = this.samples.filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = (p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 0.004;
    const noiseFloor = Math.max(0.001, Math.min(0.05, percentile(0.65)));
    const peakAmbient = Math.max(noiseFloor, percentile(0.95));
    const noiseGate = Math.max(0.004, Math.min(0.05, peakAmbient * 1.8 + 0.0015));
    const result = { noiseFloor, noiseGate, calibratedAt: new Date().toISOString(), samples: values.length };
    // Blocked or full storage must not stop the promise resolving: the app
    // mutes the synth until calibration settles, so a throw here muted it
    // until reload. The gate still applies for this session either way.
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(result));
      result.persisted = true;
    } catch {
      result.persisted = false;
    }
    this.resolve?.(result);
    this.resolve = null;
    return result;
  }
}

function inRange(value, min, max) { return Number.isFinite(value) && value >= min && value <= max; }
