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
  start(t) { this.started = t; }
  stop(t) { this.stopped = t; }
}
class Buffer {
  constructor(channels, length, sampleRate) { this.data = Array.from({ length: channels }, () => new Float32Array(length)); this.length = length; this.sampleRate = sampleRate; this.duration = length / sampleRate; }
  getChannelData(i) { return this.data[i]; }
}
class FakeContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 1; this.state = 'running'; this.destination = new Node('destination'); this.suspends = 0; }
  createOscillator() { return new Node('osc', ['frequency', 'detune']); }
  createConstantSource() { return new Node('constant', ['offset']); }
  createGain() { return new Node('gain', ['gain']); }
  createBiquadFilter() { return new Node('filter', ['frequency', 'Q']); }
  createDelay() { return new Node('delay', ['delayTime']); }
  createConvolver() { return new Node('convolver'); }
  // Numbered so the graph test can tell the heard limiter from its twin.
  createDynamicsCompressor() { this.comps = (this.comps || 0) + 1; return new Node(this.comps === 1 ? 'limiter' : 'recLimiter', ['threshold', 'knee', 'ratio', 'attack', 'release']); }
  createBufferSource() { return new Node('source', ['playbackRate']); }
  createMediaStreamDestination() { return Object.assign(new Node('record'), { stream: {} }); }
  createMediaStreamSource() { return new Node('mic'); }
  createAnalyser() { return new Node('analyser'); }
  createBuffer(ch, len, rate) { return new Buffer(ch, len, rate); }
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

const { AudioEngine, recordingExtension, MUTE_TAU_S, DYNAMICS_DEFAULTS } = await import('../src/audio/audio-engine.js');

async function started() {
  const e = new AudioEngine();
  await e.start();
  return e;
}

function reaches(from, to) {
  const seen = new Set();
  const walk = n => {
    if (n === to) return true;
    if (!n?.out || seen.has(n)) return false;
    seen.add(n);
    return n.out.some(walk);
  };
  return walk(from);
}

test('loop and click join the heard limiter, and only master reaches the recorder', async () => {
  const e = await started();
  assert.deepEqual(e.master.out.map(n => n.kind), ['limiter', 'recLimiter']);
  assert.deepEqual(e.limiter.out.map(n => n.kind), ['destination']);
  assert.deepEqual(e.recLimiter.out.map(n => n.kind), ['record']);
  assert.deepEqual(e.loopBus.out.map(n => n.kind), ['limiter']);
  assert.deepEqual(e.clickBus.out.map(n => n.kind), ['limiter']);
  assert.ok(reaches(e.master, e.recordDestination));
  assert.ok(!reaches(e.loopBus, e.recordDestination));
  assert.ok(!reaches(e.clickBus, e.recordDestination));
  assert.ok(reaches(e.loopBus, e.context.destination));
  for (const key of ['threshold', 'knee', 'ratio', 'attack', 'release']) assert.equal(e.recLimiter[key].value, e.limiter[key].value, key);
  assert.equal(e.limiter.threshold.value, -6);
  assert.equal(e.loopBus.gain.value, 0.8);
  assert.equal(e.clickBus.gain.value, 0.5);
});

test('loop and click levels clamp to 0..1 and ramp', async () => {
  const e = await started();
  e.setLoopLevel(1.7);
  assert.deepEqual(e.loopBus.gain.events.at(-1), ['target', 1, 1, 0.025]);
  e.setClickLevel(-1);
  assert.deepEqual(e.clickBus.gain.events.at(-1), ['target', 0, 1, 0.025]);
});

test('the loop buffer is a mono copy of exactly the asked length, zero padded', async () => {
  const e = await started();
  const decoded = e.context.createBuffer(2, 100, 48000);
  decoded.getChannelData(0).forEach((_, i, a) => { a[i] = i; });
  const out = e.makeLoopBuffer(decoded, { start: 90, frames: 20 });
  assert.equal(out.data.length, 1);
  assert.equal(out.length, 20);
  assert.equal(out.getChannelData(0)[0], 90);
  assert.equal(out.getChannelData(0)[9], 99);
  assert.equal(out.getChannelData(0)[10], 0);
  assert.equal(e.createClickBuffer(2400).length, 960);
});

test('startRecording notes the context time just before start', async () => {
  const e = await started();
  e.context.currentTime = 7.25;
  e.startRecording();
  assert.equal(e.startCallTime, 7.25);
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

test('the A4 reference moves the oscillator base, not the detune', async () => {
  const e = await started();
  assert.equal(e.oscillator.frequency.value, 440);
  const modBefore = e.detuneMod.offset.events.length;
  e.setReferenceA4(432);
  assert.deepEqual(e.oscillator.frequency.events.at(-1), ['set', 432, 1]);
  assert.equal(e.oscillator.detune.events.length, 0);
  e.setPitch(69, 45);
  assert.deepEqual(e.oscillator.detune.events.at(-1).slice(0, 2), ['target', 0]);
  e.setReferenceA4(999);
  assert.equal(e.referenceA4, 450);
  e.setReferenceA4('');
  assert.equal(e.referenceA4, 440);
  assert.equal(e.oscillator.detune.events.length, 2);
  assert.equal(e.detuneMod.offset.events.length, modBefore);
});

test('a reference set before start is built into the graph', async () => {
  const e = new AudioEngine();
  e.setReferenceA4(435);
  await e.start();
  assert.equal(e.oscillator.frequency.value, 435);
});

test('attack or release is chosen against the modeled gain, not the last target', async () => {
  const e = await started();
  e.setDynamics({ attackMs: 30, releaseMs: 600, curve: 1 });
  e.setVoiceLevelNormalized(0.8);
  assert.ok(Math.abs(e.voiceGain.gain.events.at(-1)[3] - 0.01) < 1e-12);
  e.context.currentTime += 1;
  e.setVoiceLevelNormalized(0.2);
  assert.ok(Math.abs(e.voiceGain.gain.events.at(-1)[3] - 0.2) < 1e-12);
  e.context.currentTime += 0.05;
  // The gain is still about 0.667 here (Chromium gave 0.6673), so 0.5 is a
  // fall. Choosing by the last target (0.2) would call it an attack.
  assert.ok(Math.abs(e.levelAt(e.context.currentTime) - 0.667) < 0.001);
  e.setVoiceLevelNormalized(0.5);
  assert.ok(Math.abs(e.voiceGain.gain.events.at(-1)[3] - 0.2) < 1e-12);
});

test('dynamics clamp to their limits and ignore non-finite values', async () => {
  const e = await started();
  assert.deepEqual(e.dynamics, { ...DYNAMICS_DEFAULTS });
  e.setDynamics({ attackMs: 0, releaseMs: 1e9, curve: 99 });
  assert.deepEqual(e.dynamics, { attackMs: 1, releaseMs: 2000, curve: 2.5 });
  e.setDynamics({ attackMs: NaN, releaseMs: '50', curve: Infinity });
  assert.deepEqual(e.dynamics, { attackMs: 1, releaseMs: 2000, curve: 2.5 });
  e.setDynamics({ curve: 2 });
  e.setVoiceLevel(0.008 + 0.061, 1, 0.008);
  assert.ok(Math.abs(e.voiceGain.gain.events.at(-1)[1] - 0.25) < 1e-9);
});

test('mute is fast whatever the release, and silences inside the guard probe', async () => {
  const e = await started();
  e.setDynamics({ attackMs: 500, releaseMs: 2000 });
  e.setVoiceLevelNormalized(0.8);
  e.context.currentTime += 1;
  e.release();
  assert.ok(Math.abs(e.voiceGain.gain.events.at(-1)[3] - 2 / 3) < 1e-12);
  e.context.currentTime += 0.1;
  e.mute();
  assert.deepEqual(e.voiceGain.gain.events.at(-1), ['target', 0, e.context.currentTime, MUTE_TAU_S]);
  assert.ok(0.3 / MUTE_TAU_S > Math.log(100));
  assert.ok(e.levelAt(e.context.currentTime + 0.3) < 0.01);
});

test('a mute in force schedules nothing more, and a new level rearms it', async () => {
  const e = await started();
  e.setVoiceLevelNormalized(0.6);
  e.context.currentTime += 0.5;
  // At the default release, 105 / 3000 equals MUTE_TAU_S exactly; the flag,
  // not a comparison of time constants, decides whether a mute is in force.
  e.release();
  assert.equal(e.voiceGain.gain.events.at(-1)[3], 0.035);
  const n = e.voiceGain.gain.events.length;
  e.mute();
  assert.equal(e.voiceGain.gain.events.length, n + 1);
  assert.equal(e.muting, true);
  e.mute();
  e.release();
  assert.equal(e.voiceGain.gain.events.length, n + 1);
  e.setVoiceLevelNormalized(0.3);
  assert.equal(e.muting, false);
  e.mute();
  assert.equal(e.voiceGain.gain.events.length, n + 3);
  e.setVoiceLevelNormalized(0.3);
  await e.suspend();
  assert.equal(e.muting, true);
});
