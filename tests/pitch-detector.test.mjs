import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchDetector, windowSizeFor } from '../src/audio/pitch-detector.js';

const PITCHES = [72, 82, 110, 147, 196, 262, 330, 440, 523, 660, 880, 1100];

// Seeded so a failure names a case that reruns the same way.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Harmonic series with 1/h rolloff and fixed phases, like a sung vowel, plus
// uniform noise of the given rms. fund 0.15 is the weak fundamental real
// voices often have. The clean signal's rms is about 0.044.
function voice(f0, sr, { fund = 1, noise = 0, seed = 1, harmonics = 12 } = {}) {
  const n = windowSizeFor(sr);
  const r = rng(seed);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let h = 1; h <= harmonics && f0 * h < sr / 2; h++) s += (h === 1 ? fund : 1 / h) * Math.sin(2 * Math.PI * f0 * h * i / sr + h);
    b[i] = 0.05 * s + noise * Math.sqrt(3) * (r() * 2 - 1);
  }
  return b;
}

const cents = (hz, ref) => 1200 * Math.log2(hz / ref);

test('window fits two periods of 65 Hz', () => {
  assert.equal(windowSizeFor(48000), 2048);
  assert.equal(windowSizeFor(44100), 2048);
  assert.equal(windowSizeFor(96000), 4096);
  assert.equal(windowSizeFor(16000), 1024);
});

// noise 0.02 is about 7 dB SNR, where v0.3's YIN read 35 of 60 an octave or
// more low. Unvoiced is an acceptable answer in noise; a wrong note is not.
for (const sr of [16000, 44100, 48000, 96000]) {
  test(`every pitch within 20 cents at ${sr} Hz, full and weak fundamental, clean to noisy`, () => {
    const d = new PitchDetector(sr);
    for (const fund of [1, 0.15]) {
      for (const noise of [0, 0.005, 0.02]) {
        let voiced = 0;
        for (const f0 of PITCHES) {
          for (let seed = 1; seed <= 3; seed++) {
            const r = d.detect(voice(f0, sr, { fund, noise, seed }));
            if (!r.voiced) continue;
            voiced++;
            const off = cents(r.pitchHz, f0);
            assert.ok(Math.abs(off) < 20, `${f0} Hz (fund ${fund}, noise ${noise}, seed ${seed}) read ${r.pitchHz.toFixed(1)} Hz`);
          }
        }
        const all = PITCHES.length * 3;
        if (noise < 0.02) assert.equal(voiced, all, `fund ${fund} noise ${noise}: only ${voiced} voiced`);
        else assert.ok(voiced >= all * 0.75, `fund ${fund} noise ${noise}: only ${voiced} voiced`);
      }
    }
  });
}

test('tones above maxHz read unvoiced instead of an octave low', () => {
  const d = new PitchDetector(48000);
  for (const f0 of [1500, 1600, 1800, 2400, 3000]) {
    for (const harmonics of [1, 8]) {
      assert.equal(d.detect(voice(f0, 48000, { harmonics })).voiced, false, `${f0} Hz`);
    }
  }
  assert.ok(Math.abs(cents(d.detect(voice(1300, 48000, { harmonics: 8 })).pitchHz, 1300)) < 20);
});

test('tones below minHz read unvoiced', () => {
  const d = new PitchDetector(48000);
  for (const f0 of [40, 50, 58]) assert.equal(d.detect(voice(f0, 48000)).voiced, false, `${f0} Hz`);
});

test('silence and noise are unvoiced', () => {
  const d = new PitchDetector(48000);
  assert.equal(d.detect(new Float32Array(2048)).voiced, false);
  const r = rng(7);
  const noise = new Float32Array(2048).map(() => 0.1 * (r() * 2 - 1));
  assert.equal(d.detect(noise).voiced, false);
});

test('the noise gate and threshold are configurable', () => {
  const d = new PitchDetector(48000);
  d.configure({ noiseGate: 0.5, threshold: 2 });
  assert.equal(d.noiseGate, 0.5);
  assert.equal(d.threshold, 0.95);
  assert.equal(d.detect(voice(220, 48000)).voiced, false);
});
