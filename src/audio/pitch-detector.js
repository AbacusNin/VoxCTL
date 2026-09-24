// The one pitch detector. Both analysis paths feed it: the AudioWorklet ships
// raw sample windows to the main thread, and the fallback reads the
// AnalyserNode. Keeping a single copy means the paths cannot disagree, and no
// pitch search runs on the audio thread.
//
// McLeod pitch method (NSDF + key-maximum picking) for monophonic voice.
// v0.3 shipped YIN here. On clean input the two agree, but when no YIN dip
// crosses its threshold (a weak fundamental plus room noise) YIN fell back to
// the global minimum, which sits on a multiple of the period, and read notes
// one or more octaves low at about 84% confidence. On synthetic voices at
// 48 kHz and about 7 dB SNR, YIN read 35 of 60 wrong and this method 0. At
// 3.4 dB a repaired YIN still read 6 wrong; this method still read 0.
// See McLeod & Wyvill, "A Smarter Way to Find Pitch" (2005).

// Smallest window that fits two periods of the lowest pitch.
export function windowSizeFor(sampleRate, minHz = 65) {
  let size = 1024;
  while (size < (2 * sampleRate) / minHz && size < 32768) size *= 2;
  return size;
}

export class PitchDetector {
  constructor(sampleRate, { minHz = 65, maxHz = 1400, threshold = 0.62, peakRatio = 0.85, noiseGate = 0.008 } = {}) {
    this.sampleRate = sampleRate;
    this.minHz = minHz;
    this.maxHz = maxHz;
    this.threshold = threshold;
    this.peakRatio = peakRatio;
    this.noiseGate = noiseGate;
  }

  configure({ noiseGate, threshold } = {}) {
    if (Number.isFinite(noiseGate)) this.noiseGate = Math.max(0.001, noiseGate);
    if (Number.isFinite(threshold)) this.threshold = Math.max(0.3, Math.min(0.95, threshold));
  }

  detect(buffer) {
    const n = buffer.length;
    let sumSq = 0, deltaSq = 0, zeroCrossings = 0;
    for (let i = 0; i < n; i++) {
      sumSq += buffer[i] * buffer[i];
      if (i > 0) {
        const d = buffer[i] - buffer[i - 1];
        deltaSq += d * d;
        if ((buffer[i - 1] < 0) !== (buffer[i] < 0)) zeroCrossings++;
      }
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    const zcr = zeroCrossings / Math.max(1, n - 1);
    const deltaRms = Math.sqrt(deltaSq / Math.max(1, n - 1));
    const brightnessProxy = Math.max(0, Math.min(1, (deltaRms / Math.max(rms, 1e-5)) / 2.6));
    const unvoiced = (confidence = 0) => ({ pitchHz: 0, confidence, rms, zcr, brightnessProxy, voiced: false, detector: 'mpm' });
    if (rms < this.noiseGate) return unvoiced();

    // The search costs window x maxLag, so it grows with the square of the
    // sample rate: 8.6 ms per frame at 96 kHz against 2 ms at 48 kHz. Above
    // 50 kHz, halve the rate by averaging sample pairs (a mild low-pass, so
    // noise above the new Nyquist does not fold straight back into band).
    let data = buffer, rate = this.sampleRate;
    if (rate > 50000) {
      data = new Float32Array(n >> 1);
      for (let i = 0; i < data.length; i++) data[i] = 0.5 * (buffer[2 * i] + buffer[2 * i + 1]);
      rate /= 2;
    }
    const len = data.length;
    const minLag = Math.max(2, Math.floor(rate / this.maxHz));
    const maxLag = Math.min(len >> 1, Math.ceil(rate / this.minHz) + 1);
    const nsdf = new Float32Array(maxLag + 1);

    for (let lag = 0; lag <= maxLag; lag++) {
      let acf = 0, m = 0;
      for (let i = 0, limit = len - lag; i < limit; i++) {
        const a = data[i], b = data[i + lag];
        acf += a * b;
        m += a * a + b * b;
      }
      nsdf[lag] = m > 0 ? (2 * acf) / m : 0;
    }

    // Key maxima: the highest point of each positive lobe after the first
    // zero crossing. A lobe still rising at maxLag is cut off, so it is skipped.
    const peaks = [];
    let lag = 1;
    while (lag <= maxLag && nsdf[lag] > 0) lag++;
    let peak = -1;
    for (; lag <= maxLag; lag++) {
      if (nsdf[lag] > 0) {
        if (peak < 0 || nsdf[lag] > nsdf[peak]) peak = lag;
      } else if (peak >= 0) {
        peaks.push(peak);
        peak = -1;
      }
    }
    if (peak >= 0 && peak < maxLag) peaks.push(peak);
    if (!peaks.length) return unvoiced();

    // Lobes shorter than minLag are searched too. A tone above maxHz has its
    // true period there, and skipping it let the next lobe (twice the period)
    // win, so whistling read an octave low. Now it reads unvoiced.
    // Peaks are compared by interpolated height, and peakRatio is 0.85 rather
    // than 0.9: at 16 kHz a 1100 Hz period falls between samples, its lobe
    // peaks at 0.89 against 0.99 for two periods, and it read an octave low.
    const fitted = peaks.map(p => parabolicPeak(nsdf, p));
    const top = Math.max(...fitted.map(f => f.height));
    const index = fitted.findIndex(f => f.height >= this.peakRatio * top);
    const best = peaks[index];
    if (best < minLag) return unvoiced();
    const confidence = Math.max(0, Math.min(1, fitted[index].height));
    if (confidence < this.threshold) return unvoiced(confidence);

    const pitchHz = rate / fitted[index].lag;
    return { pitchHz, confidence, rms, zcr, brightnessProxy, voiced: true, detector: 'mpm' };
  }
}

// Parabola through a key maximum and its neighbors. The peak is interior to
// its lobe, so both neighbors exist.
function parabolicPeak(values, i) {
  const y1 = values[i - 1], y2 = values[i], y3 = values[i + 1];
  const denom = y1 - 2 * y2 + y3;
  const shift = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (y1 - y3) / denom));
  return { lag: i + shift, height: y2 - 0.25 * (y1 - y3) * shift };
}
