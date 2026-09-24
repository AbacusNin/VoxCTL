export class FeatureEngine {
  constructor(analyser, sampleRate) {
    this.analyser = analyser;
    this.sampleRate = sampleRate;
    this.frequencyData = new Float32Array(analyser.frequencyBinCount);
    this.smoothedSpectrum = new Float32Array(analyser.frequencyBinCount);
    this.pitchHistory = [];
  }

  enrich(signal) {
    const spectral = this.analyzeSpectrum();
    const vibrato = this.analyzeVibrato(signal);
    const confidence = Number(signal.confidence) || 0;
    const noisiness = Math.max(0, Math.min(1,
      ((signal.zcr || 0) / 0.18) * 0.45 + (1 - confidence) * 0.55
    ));

    return {
      ...signal,
      spectralCentroid: spectral.centroid,
      brightness: Math.max(spectral.brightness, signal.brightnessProxy || 0),
      formant1: spectral.formant1,
      formant2: spectral.formant2,
      noisiness,
      vibratoRate: vibrato.rate,
      vibratoDepth: vibrato.depth
    };
  }

  analyzeSpectrum() {
    this.analyser.getFloatFrequencyData(this.frequencyData);
    const bins = this.frequencyData.length;
    const binHz = this.sampleRate / this.analyser.fftSize;
    let weighted = 0;
    let total = 0;
    let high = 0;

    // Smooth the spectrum into a coarse spectral envelope for formant estimates.
    const radius = 5;
    for (let i = 0; i < bins; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(bins - 1, i + radius); j++) {
        sum += this.frequencyData[j];
        count++;
      }
      this.smoothedSpectrum[i] = sum / count;
    }

    const minBin = Math.max(1, Math.floor(70 / binHz));
    const maxBin = Math.min(bins - 1, Math.floor(8000 / binHz));
    for (let i = minBin; i <= maxBin; i++) {
      const db = this.frequencyData[i];
      if (!Number.isFinite(db) || db < -110) continue;
      const magnitude = Math.pow(10, db / 20);
      const hz = i * binHz;
      total += magnitude;
      weighted += hz * magnitude;
      if (hz >= 2200) high += magnitude;
    }

    const centroid = total > 0 ? weighted / total : 0;
    const brightness = total > 0 ? Math.max(0, Math.min(1, (high / total) * 2.4)) : 0;
    const formant1 = this.findEnvelopePeak(250, 1000, binHz);
    const f2Min = formant1 ? Math.max(800, formant1 + 300) : 800;
    const formant2 = this.findEnvelopePeak(f2Min, 3200, binHz);
    return { centroid, brightness, formant1, formant2 };
  }

  findEnvelopePeak(minHz, maxHz, binHz) {
    const minBin = Math.max(1, Math.floor(minHz / binHz));
    const maxBin = Math.min(this.smoothedSpectrum.length - 2, Math.ceil(maxHz / binHz));
    let bestBin = 0;
    let bestDb = -Infinity;
    for (let i = minBin; i <= maxBin; i++) {
      const value = this.smoothedSpectrum[i];
      if (value > bestDb) {
        bestDb = value;
        bestBin = i;
      }
    }
    return bestDb > -95 ? bestBin * binHz : 0;
  }

  // Measuring spread around the median counted any pitch movement as
  // vibrato, so a sung melody read as 200 cents deep and swelled whatever
  // vibratoDepth was mapped to. Here the pitch track is detrended first, and
  // depth is only reported when the wobble is periodic at a vibrato rate.
  analyzeVibrato(signal, now = performance.now()) {
    const none = { rate: 0, depth: 0 };
    if (signal.voiced && signal.pitchHz > 0 && signal.confidence > 0.55) {
      // Any fixed base works here, and the A4 reference does not matter:
      // only differences in cents are used.
      const cents = 1200 * Math.log2(signal.pitchHz / 440);
      const last = this.pitchHistory[this.pitchHistory.length - 1];
      // Wider than any per-frame vibrato swing: a new note, so start over.
      if (last && Math.abs(cents - last.cents) > 150) this.pitchHistory = [];
      this.pitchHistory.push({ t: now, cents });
    }
    const cutoff = now - 1400;
    while (this.pitchHistory.length && this.pitchHistory[0].t < cutoff) this.pitchHistory.shift();
    const h = this.pitchHistory;
    if (h.length < 8) return none;

    // Subtract a moving average about one vibrato cycle wide. It follows
    // glides and note steps but averages a 4-8 Hz wobble to roughly zero.
    const HALF_MS = 100;
    const residual = [];
    for (const p of h) {
      if (p.t - h[0].t < HALF_MS || h[h.length - 1].t - p.t < HALF_MS) continue;
      let sum = 0, count = 0;
      for (const q of h) if (Math.abs(q.t - p.t) <= HALF_MS) { sum += q.cents; count++; }
      residual.push({ t: p.t, v: p.cents - sum / count });
    }
    if (residual.length < 6) return none;

    const sorted = residual.map(r => r.v).sort((a, b) => a - b);
    const depth = (sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)]) / 2;

    // Sign changes, ignoring a 2-cent deadband so detector jitter does not count.
    let crossings = 0, sign = 0;
    for (const { v } of residual) {
      if (Math.abs(v) < 2) continue;
      const s = Math.sign(v);
      if (sign && s !== sign) crossings++;
      sign = s;
    }
    const duration = (residual[residual.length - 1].t - residual[0].t) / 1000;
    const rate = duration > 0 ? crossings / 2 / duration : 0;
    if (rate < 2 || rate > 10 || depth < 4) return none;
    return { rate, depth: Math.min(depth, 200) };
  }
}
