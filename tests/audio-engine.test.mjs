import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough of Web Audio to build the graph and record what it schedules.
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setTargetAtTime(v, t, tau) { this.events.push(['target', v, t, tau]); }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); }
}
class Node {
  constructor(kind, params = []) {
    this.kind = kind;
    this.out = [];
    for (const p of params) this[p] = new Param();
  }
  connect(target) { this.out.push(target); return target; }
  start() {}
}
class FakeContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 1; this.state = 'running'; this.destination = new Node('destination'); this.suspends = 0; }
  createOscillator() { return new Node('osc', ['frequency', 'detune']); }
  createConstantSource() { return new Node('constant', ['offset']); }
  createGain() { return new Node('gain', ['gain']); }
  createBiquadFilter() { return new Node('filter', ['frequency', 'Q']); }
  createDelay() { return new Node('delay', ['delayTime']); }
  createConvolver() { return new Node('convolver'); }
  createDynamicsCompressor() { return new Node('limiter', ['threshold', 'knee', 'ratio', 'attack', 'release']); }
  createMediaStreamDestination() { return Object.assign(new Node('record'), { stream: {} }); }
  createMediaStreamSource() { return new Node('mic'); }
  createAnalyser() { return new Node('analyser'); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  async resume() { this.state = 'running'; }
  async suspend() { this.suspends++; this.state = 'suspended'; }
}
class FakeRecorder {
  constructor(stream, opts) { this.mimeType = opts?.mimeType || 'audio/webm'; this.state = 'inactive'; }
  static isTypeSupported(type) { return type === 'audio/mp4'; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
}

let gumCalls = 0;
globalThis.window = { AudioContext: FakeContext, MediaRecorder: FakeRecorder };
globalThis.MediaRecorder = FakeRecorder;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => { gumCalls++; return {}; } } } });

const { AudioEngine, recordingExtension } = await import('../src/audio/audio-engine.js');

async function started() {
  const e = new AudioEngine();
  await e.start();
  return e;
}

test('the limiter sits between master and the output, and the recorder taps after it', async () => {
  const e = await started();
  assert.deepEqual(e.master.out.map(n => n.kind), ['limiter']);
  assert.deepEqual(e.limiter.out.map(n => n.kind).sort(), ['destination', 'record']);
  assert.equal(e.limiter.threshold.value, -6);
});

test('mapping detune rides a separate source into oscillator detune', async () => {
  const e = await started();
  assert.ok(e.detuneMod.out.includes(e.oscillator.detune));
  e.setMappingModulations({ detune: 0.05 });
  assert.equal(e.getModulationCents(), 60);
  assert.deepEqual(e.detuneMod.offset.events.at(-1).slice(0, 2), ['target', 60]);
  assert.equal(e.oscillator.detune.events.length, 0);
});

test('pitch glides once in cents on the audio clock, and jumps after silence', async () => {
  const e = await started();
  e.setPitch(81, 300);
  const [kind, cents, , tau] = e.oscillator.detune.events.at(-1);
  assert.equal(kind, 'target');
  assert.equal(cents, 1200);
  assert.ok(Math.abs(tau - 0.1) < 1e-9);
  e.setPitch(57, 300, { jump: true });
  assert.deepEqual(e.oscillator.detune.events.at(-1), ['set', -1200, 1]);
});

test('a plugin can duck the output but not raise it', async () => {
  const e = await started();
  e.setMaster(0.1);
  e.setPluginMasterOffset(1);
  assert.equal(e.plugin.master, 0);
  e.setPluginMasterOffset(-0.5);
  assert.equal(e.plugin.master, -0.5);
});

test('two overlapping starts open one microphone stream', async () => {
  gumCalls = 0;
  const e = new AudioEngine();
  await Promise.all([e.start(), e.start()]);
  assert.equal(gumCalls, 1);
});

test('hiding the tab suspends, except while a take is recording', async () => {
  const e = await started();
  assert.equal(await e.suspend(), true);
  assert.equal(e.context.suspends, 1);
  await e.resume();
  e.startRecording();
  assert.equal(await e.suspend(), false);
  assert.equal(e.context.suspends, 1);
  assert.deepEqual(e.voiceGain.gain.events.at(-1), ['set', 0, 1]);
});

test('each take keeps its own chunks, and mp4 takes save as m4a', async () => {
  const e = await started();
  e.startRecording();
  e.recorder.ondataavailable({ data: new Blob(['a']) });
  const first = e.stopRecording();
  e.startRecording();
  e.recorder.ondataavailable({ data: new Blob(['bb']) });
  const blob = await first;
  assert.equal(blob.size, 1);
  assert.equal(blob.type, 'audio/mp4');
  assert.equal(recordingExtension(blob.type), 'm4a');
  assert.equal(recordingExtension('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(recordingExtension('audio/webm;codecs=opus'), 'webm');
});

test('a recorder error mid-take is reported and releases the recorder', async () => {
  const e = await started();
  let reported = null;
  e.onRecordingError = error => { reported = error; };
  e.startRecording();
  e.recorder.onerror({ error: new Error('device lost') });
  assert.equal(reported.message, 'device lost');
  assert.equal(e.recorder, null);
});

test('recording before start says so instead of blaming the browser', () => {
  assert.throws(() => new AudioEngine().startRecording(), /Start the instrument first/);
});
