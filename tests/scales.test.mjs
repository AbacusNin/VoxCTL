import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantizeMidi, quantizeMidiSticky, parseCustomScale, normalizeCents, scaleOffsets, MAX_CUSTOM_DEGREES, hzToMidi, midiToHz, centsOffset, clampReference } from '../src/mapping/scales.js';

const EDO24 = Array.from({ length: 24 }, (_, i) => i * 50);

test('quantizeMidi snaps to the nearest note of the scale', () => {
  assert.equal(quantizeMidi(60.8, 'C', 'major'), 60);
  assert.equal(quantizeMidi(61.2, 'C', 'major'), 62);
  assert.equal(quantizeMidi(-12.4, 'C', 'chromatic'), -12);
});

test('custom cents scales quantize, from a string or a parsed array', () => {
  assert.equal(quantizeMidi(60.24, 'C', 'custom', EDO24), 60);
  assert.equal(quantizeMidi(60.26, 'C', 'custom', EDO24), 60.5);
  assert.equal(quantizeMidi(-3.3, 'C', 'custom', EDO24.join(',')), -3.5);
  assert.equal(quantizeMidi(65.4, 'D', 'custom', '0, 350, 700'), 65.5);
});

test('a voice wavering around the midpoint holds one note', () => {
  let prev = null;
  const seen = new Set();
  for (const midi of [60.9, 61.1, 60.95, 61.05, 61.12, 60.8]) {
    prev = quantizeMidiSticky(midi, prev, 'C', 'major');
    seen.add(prev);
  }
  assert.equal(seen.size, 1);
});

test('a voice at a degree boundary flips at most once in 100 frames, chromatic and 24-EDO', () => {
  const cases = [['chromatic', null, 60.5, 0.03], ['custom', EDO24, 60.25, 0.02]];
  for (const [scale, custom, center, spread] of cases) {
    let prev = null, flips = 0;
    for (let i = 0; i < 100; i++) {
      const next = quantizeMidiSticky(center + spread * Math.sin(i * 2.1), prev, 'C', scale, custom);
      if (prev !== null && next !== prev) flips++;
      prev = next;
    }
    assert.ok(flips <= 1, `${scale}: ${flips} flips`);
  }
});

test('a clear move past the margin changes note', () => {
  assert.equal(quantizeMidiSticky(61.4, 60, 'C', 'major'), 62);
});

test('a held note from a scale or root the user left is dropped', () => {
  // 61 (C#) is not in C major, so it cannot be held
  assert.equal(quantizeMidiSticky(61.3, 61, 'C', 'major'), 62);
  // 60.5 was a 24-EDO degree, not one of a 0/350/700 scale
  assert.equal(quantizeMidiSticky(60.6, 60.5, 'C', 'custom', [0, 350, 700]), 60);
  // a held custom degree survives while it is still in the scale
  assert.equal(quantizeMidiSticky(63.7, 63.5, 'C', 'custom', [0, 350, 700]), 63.5);
});

test('custom scale parsing rounds before wrapping and rejects non-decimal tokens', () => {
  assert.deepEqual(parseCustomScale('0, 1199.9996'), [0]);
  assert.deepEqual(parseCustomScale('0x10, 1e3, 700'), [0, 700]);
  assert.deepEqual(parseCustomScale('-100; 1300'), [0, 100, 1100]);
  assert.deepEqual(parseCustomScale(''), [0]);
  assert.deepEqual(normalizeCents([702, 1902, NaN, 'x']), [0, 702]);
});

test('custom scales are capped at the preset limit', () => {
  const long = Array.from({ length: 5000 }, (_, i) => (i * 0.2).toFixed(1)).join(' ');
  assert.equal(parseCustomScale(long).length, MAX_CUSTOM_DEGREES);
  assert.ok(scaleOffsets('custom', long).length <= MAX_CUSTOM_DEGREES);
});

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('conversions take the A4 reference, defaulting to 440', () => {
  assert.equal(hzToMidi(432, 432), 69);
  assert.equal(midiToHz(69, 450), 450);
  assert.ok(near(hzToMidi(midiToHz(61.37, 437.5), 437.5), 61.37));
  assert.equal(hzToMidi(440), 69);
  assert.equal(midiToHz(69), 440);
});

test('cents offset is measured against the reference and stays within half a semitone', () => {
  assert.ok(near(centsOffset(440, 432), 1200 * Math.log2(440 / 432)));
  assert.ok(near(centsOffset(440, 432), 31.77, 0.01));
  assert.ok(near(centsOffset(445, 440), 19.56, 0.01));
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i++) {
    const c = centsOffset(60 + rand() * 1400, 430 + rand() * 20);
    assert.ok(c >= -50 && c <= 50, `${c}`);
  }
});

test('the reference clamps to 430..450, and blank or junk input means 440', () => {
  for (const bad of ['', '  ', 'abc', NaN, null, undefined, Infinity, '440abc', {}, []]) assert.equal(clampReference(bad), 440, String(bad));
  assert.equal(clampReference(429), 430);
  assert.equal(clampReference('451'), 450);
  assert.equal(clampReference('432.5'), 432.5);
  assert.equal(clampReference(441.3), 441.3);
});

test('quantizing works in reference space, including custom cents scales', () => {
  const ref = 432;
  assert.ok(near(midiToHz(quantizeMidi(hzToMidi(ref * 2 ** (0.3 / 12), ref), 'A', 'chromatic'), ref), 432));
  const sung = hzToMidi(ref * 2 ** (45 / 1200), ref);
  assert.ok(near(midiToHz(quantizeMidi(sung, 'A', 'custom', [0, 50, 100]), ref), ref * 2 ** (50 / 1200)));
});
