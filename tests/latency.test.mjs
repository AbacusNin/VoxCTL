import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateLatency, estimateRoundTripSeconds } from '../src/audio/latency.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const part = (est, key) => est.parts.find(p => p.key === key).ms;

test('a full report sums every part, with half the window and half the cadence', () => {
  const est = estimateLatency({ baseLatency: 0.01, outputLatency: 0.02, trackLatency: 0.005, sampleRate: 48000, windowSize: 2048, cadenceMs: 30 });
  assert.deepEqual(est.parts.map(p => p.key), ['input', 'window', 'cadence', 'base', 'output']);
  assert.ok(near(part(est, 'window'), 21.3333333, 1e-6));
  assert.ok(near(est.totalMs, 5 + 2048 / 48000 * 500 + 15 + 10 + 20));
  assert.equal(est.partial, false);
});

test('unreported values are null and mark the total partial instead of counting as 0', () => {
  const est = estimateLatency({ baseLatency: 0.01, sampleRate: 48000, windowSize: 2048, cadenceMs: 30 });
  assert.equal(part(est, 'output'), null);
  assert.equal(part(est, 'input'), null);
  assert.equal(est.partial, true);
  assert.ok(near(est.totalMs, 2048 / 48000 * 500 + 15 + 10));
});

test('negative, non-numeric and infinite browser values are not reported', () => {
  const est = estimateLatency({ baseLatency: -1, outputLatency: 'x', trackLatency: Infinity, sampleRate: 48000, windowSize: 2048, cadenceMs: 30 });
  for (const key of ['base', 'output', 'input']) assert.equal(part(est, key), null, key);
});

test('a zero or missing cadence is not reported, and a stall-length one is capped', () => {
  assert.equal(part(estimateLatency({ cadenceMs: 0 }), 'cadence'), null);
  assert.equal(part(estimateLatency({ cadenceMs: NaN }), 'cadence'), null);
  assert.equal(part(estimateLatency({ cadenceMs: 5000 }), 'cadence'), 500);
  assert.equal(part(estimateLatency({ sampleRate: 48000 }), 'window'), null);
  assert.equal(estimateLatency().partial, true);
});

test('the round trip for take alignment adds analysis and the limiter, or is null with nothing reported', () => {
  assert.equal(estimateRoundTripSeconds({ sampleRate: 48000, windowSize: 2048 }), null);
  assert.equal(estimateRoundTripSeconds({ baseLatency: -1, outputLatency: NaN }), null);
  const s = estimateRoundTripSeconds({ baseLatency: 0.01, outputLatency: 0.02, trackLatency: 0.005, sampleRate: 48000, windowSize: 2048 });
  assert.ok(near(s, 0.035 + 1024 / 48000 + 0.015 + 0.006));
});
