import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchTracker } from '../src/mapping/pitch-tracker.js';
import { midiToHz, hzToMidi } from '../src/mapping/scales.js';

const QUANT = { quantized: true, root: 'C', scale: 'chromatic', strength: 1 };

test('the first voiced frame after silence jumps, later frames glide', () => {
  const t = new PitchTracker();
  assert.equal(t.update(220).jump, true);
  assert.equal(t.update(221).jump, false);
  t.reset();
  assert.equal(t.update(440).jump, true);
});

test('a phrase after silence does not start from the old note', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 5; i++) t.update(220);
  t.reset();
  assert.ok(Math.abs(t.update(440).midi - 69) < 1e-9);
});

test('a one-frame octave glitch is dropped by the median', () => {
  const t = new PitchTracker();
  t.update(220);
  t.update(220);
  const { midi } = t.update(110);
  assert.ok(Math.abs(midi - 57) < 1e-9, `got ${midi}`);
});

test('a voice hovering at a note boundary does not retrigger in quantized mode', () => {
  const t = new PitchTracker();
  let prev = null, flips = 0;
  for (let i = 0; i < 100; i++) {
    const { heldNote } = t.update(midiToHz(60.5 + 0.03 * Math.sin(i * 2.1)), QUANT);
    if (prev !== null && heldNote !== prev) flips++;
    prev = heldNote;
  }
  assert.ok(flips <= 1, `${flips} flips`);
});

test('quantize strength pulls part way, and free mode clears the held note', () => {
  const t = new PitchTracker();
  const { midi } = t.update(midiToHz(60.4), { ...QUANT, strength: 0.5 });
  assert.ok(Math.abs(midi - 60.2) < 1e-6);
  assert.equal(t.update(midiToHz(60.4)).heldNote, null);
});

test('a reference change mid-note re-expresses the median instead of resetting', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 4; i++) t.update(440);
  const first = t.update(432, { referenceA4: 432 });
  assert.equal(first.jump, false);
  // Two frames of the old 440 Hz voice, now 31.8 cents above A4, outvote one.
  assert.ok(Math.abs(first.midi - hzToMidi(440, 432)) < 1e-9);
  t.update(432, { referenceA4: 432 });
  const settled = t.update(432, { referenceA4: 432 });
  assert.equal(settled.jump, false);
  assert.ok(Math.abs(settled.midi - 69) < 1e-9);
});

test('a reference swept every frame never reports jump, so the glide stays in charge', () => {
  const t = new PitchTracker();
  t.update(440);
  let jumps = 0;
  for (let i = 0; i < 40; i++) if (t.update(440, { referenceA4: 430 + i * 0.3 }).jump) jumps++;
  assert.equal(jumps, 0);
});

test('a reference change keeps the quantized note, which then sounds at the new tuning', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 4; i++) t.update(440, QUANT);
  assert.equal(t.heldNote, 69);
  const r = t.update(440, { ...QUANT, referenceA4: 432 });
  assert.equal(r.jump, false);
  assert.equal(r.heldNote, 69);
  assert.equal(r.midi, 69);
});

test('a reference change keeps the free-mode hold in the same place in Hz', () => {
  const t = new PitchTracker();
  const opts = { hysteresisCents: 25 };
  for (let i = 0; i < 4; i++) t.update(440, opts);
  const r = t.update(440, { ...opts, referenceA4: 432 });
  assert.ok(Math.abs(midiToHz(r.midi, 432) - 440) < 1e-6);
});

const vibrato = (base, cents, i) => midiToHz(base + (cents / 100) * Math.sin(2 * Math.PI * 5.5 * i * 0.03));
const range = xs => Math.max(...xs) - Math.min(...xs);

test('free-mode hysteresis is off by default, so vibrato passes through', () => {
  const run = opts => { const t = new PitchTracker(); return Array.from({ length: 100 }, (_, i) => t.update(vibrato(60, 10, i), opts).midi); };
  const plain = run();
  assert.ok(range(plain) * 100 > 12, `${range(plain) * 100} cents`);
  assert.deepEqual(run({ hysteresisCents: 0 }), plain);
});

test('hysteresis removes shallow vibrato but lets a real step through', () => {
  const t = new PitchTracker();
  const out = Array.from({ length: 100 }, (_, i) => t.update(vibrato(60, 10, i), { hysteresisCents: 25 }).midi);
  assert.equal(range(out.slice(3)), 0);
  const after = [1, 2, 3].map(() => t.update(midiToHz(61), { hysteresisCents: 25 }).midi);
  assert.ok(after.some(m => Math.abs(m - 61) < 1e-9));
});

test('hysteresis can hold a steady offset for as long as the voice stays there', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 10; i++) t.update(midiToHz(60), { hysteresisCents: 14 });
  let last;
  for (let i = 0; i < 100; i++) last = t.update(midiToHz(60.13), { hysteresisCents: 14 }).midi;
  assert.ok(Math.abs(last - 60) < 1e-9, `${last}`);
});

test('hysteresis turns a slow glide into steps no larger than the setting plus a frame', () => {
  const t = new PitchTracker();
  const target = 61;
  const out = [];
  // 100 cents per second at 30 ms frames, then held
  for (let i = 0; i <= 40; i++) out.push(t.update(midiToHz(Math.min(target, 60 + i * 0.03)), { hysteresisCents: 14 }).midi);
  const steps = out.slice(1).map((m, i) => Math.abs(m - out[i]) * 100).filter(s => s > 0);
  assert.ok(steps.length > 3);
  assert.ok(Math.max(...steps) <= 15 + 1e-9, `${Math.max(...steps)}`);
  assert.ok(Math.abs(out.at(-1) - target) * 100 < 14);
});

test('quantized mode ignores free-mode hysteresis', () => {
  const run = h => { const t = new PitchTracker(); return Array.from({ length: 60 }, (_, i) => t.update(vibrato(60.3, 30, i), { ...QUANT, strength: 0.5, hysteresisCents: h })); };
  assert.deepEqual(run(0), run(25));
});

test('an octave leap is followed; there is no octave guard', () => {
  const t = new PitchTracker();
  for (let i = 0; i < 20; i++) t.update(220, { hysteresisCents: 25 });
  let r;
  for (let i = 0; i < 3; i++) r = t.update(440, { hysteresisCents: 25 });
  assert.equal(r.midi, 69);
});

test('a hysteresis of NaN or below zero is treated as off', () => {
  const run = h => { const t = new PitchTracker(); return Array.from({ length: 40 }, (_, i) => t.update(vibrato(60, 10, i), { hysteresisCents: h }).midi); };
  const off = run(0);
  assert.deepEqual(run(NaN), off);
  assert.deepEqual(run(-5), off);
});
