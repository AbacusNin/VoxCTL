import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PitchDetector, windowSizeFor } from '../src/audio/pitch-detector.js';

// Minimal AudioWorkletGlobalScope so the processor module can load in Node.
const SR = 48000;
let Processor;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (_, cls) => { Processor = cls; };
await import('../src/audio/worklets/analysis-worklet.js');

function makeProcessor(opts) {
  const posted = [];
  const p = new Processor({ processorOptions: opts });
  p.port = { postMessage: (msg, transfer) => posted.push({ msg, transfer }) };
  return { p, posted };
}

function feed(p, fn, samples) {
  for (let start = 0; start < samples; start += 128) {
    const block = new Float32Array(128).map((_, i) => fn(start + i));
    p.process([[block]], [[new Float32Array(128)]]);
  }
}

test('posts full windows, oldest sample first, once per hop, by transfer', () => {
  const { p, posted } = makeProcessor({ windowSize: 2048, hopSize: 1408 });
  // first post when the window fills, then one per hop
  feed(p, i => i, 2048 + 1408 * 3);
  assert.equal(posted.length, 4);
  for (const { msg, transfer } of posted) {
    assert.deepEqual(Object.keys(msg).sort(), ['samples', 'type']);
    assert.equal(msg.type, 'window');
    assert.equal(msg.samples.length, 2048);
    assert.deepEqual(transfer, [msg.samples.buffer]);
    // consecutive sample indexes means the ring was unrolled in order
    assert.equal(msg.samples[2047] - msg.samples[0], 2047);
  }
});

test('the worklet carries no pitch analysis of its own', async () => {
  const src = await readFile(new URL('../src/audio/worklets/analysis-worklet.js', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /yin|nsdf|detect|basicMetrics/i);
});

test('windows from the worklet give the right pitch through the shared detector', () => {
  const size = windowSizeFor(SR);
  const { p, posted } = makeProcessor({ windowSize: size, hopSize: 1408 });
  const d = new PitchDetector(SR);
  for (const f0 of [72, 147, 330, 880, 1100]) {
    posted.length = 0;
    feed(p, i => 0.1 * [1, 2, 3, 4].reduce((s, h) => s + Math.sin(2 * Math.PI * f0 * h * i / SR) / h, 0), size * 2);
    const r = d.detect(posted.at(-1).msg.samples);
    assert.ok(Math.abs(1200 * Math.log2(r.pitchHz / f0)) < 20, `${f0} Hz read as ${r.pitchHz}`);
  }
});
