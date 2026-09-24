import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchTracker } from '../src/mapping/pitch-tracker.js';
import { midiToHz } from '../src/mapping/scales.js';

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
