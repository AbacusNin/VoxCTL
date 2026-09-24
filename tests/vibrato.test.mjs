import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureEngine } from '../src/audio/feature-engine.js';

const FRAME = 30;

// Feeds a pitch track in cents from A4 at the app's analysis rate and
// returns the last vibrato estimate.
function track(centsAt, ms = 1500) {
  const fe = new FeatureEngine({ frequencyBinCount: 16, fftSize: 32 }, 48000);
  let out;
  for (let t = 0; t <= ms; t += FRAME) {
    out = fe.analyzeVibrato({ voiced: true, confidence: 0.9, pitchHz: 440 * 2 ** (centsAt(t) / 1200) }, t);
  }
  return out;
}

test('real vibrato reports its rate and depth', () => {
  const v = track(t => 40 * Math.sin(2 * Math.PI * 5.5 * t / 1000));
  assert.ok(Math.abs(v.rate - 5.5) < 1, `rate ${v.rate}`);
  assert.ok(Math.abs(v.depth - 40) < 12, `depth ${v.depth}`);
});

test('a sung melody is not vibrato', () => {
  // D E F G A, a step every 300 ms
  const v = track(t => -700 + [0, 200, 300, 500, 700][Math.min(4, Math.floor(t / 300))]);
  assert.equal(v.rate, 0);
  assert.equal(v.depth, 0);
});

test('a slow glide is not vibrato', () => {
  const v = track(t => -600 + 700 * (t / 1500));
  assert.equal(v.rate, 0);
  assert.equal(v.depth, 0);
});

test('vibrato riding on a glide is still found', () => {
  const v = track(t => -600 + 500 * (t / 1500) + 30 * Math.sin(2 * Math.PI * 6 * t / 1000));
  assert.ok(Math.abs(v.rate - 6) < 1.2, `rate ${v.rate}`);
  assert.ok(v.depth > 15 && v.depth < 45, `depth ${v.depth}`);
});
