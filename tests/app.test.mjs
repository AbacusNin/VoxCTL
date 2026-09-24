// Loads the real src/app.js against a small DOM, Web Audio, MIDI and speech
// shim and drives it the way a user and the audio thread would. The tests run
// in order and share one app instance, because app.js wires itself on import.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class ClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : force; on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}
class El {
  constructor(id) {
    Object.assign(this, { id, textContent: '', value: '', checked: false, disabled: false, hidden: false, innerHTML: '', files: [] });
    Object.assign(this, { classList: new ClassList(), dataset: {}, style: {}, handlers: {}, width: 1200, height: 360, clientWidth: 1160, clientHeight: 330, min: '0', max: '100' });
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.handlers[event.type] || []) fn(event); }
  fire(type, extra = {}) { this.dispatchEvent({ type, target: this, ...extra }); }
  querySelector() { return new El('q'); }
  querySelectorAll() { return []; }
  closest() { return null; }
  getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }
  click() { this.fire('click'); }
  appendChild() {} remove() {} setAttribute() {}
}

const els = {};
const initial = { glide: '45', quantizeStrength: '100', filterCutoff: '4200', delayMix: '18', reverbMix: '28', outputGain: '65', waveform: 'sine', pitchMode: 'free', scaleSelect: 'minor', rootSelect: 'D', customScaleCents: '0, 200, 300' };
const docListeners = {};
const winListeners = {};
globalThis.document = {
  getElementById: id => (els[id] ||= Object.assign(new El(id), initial[id] !== undefined ? { value: initial[id] } : {})),
  querySelector: () => new El('q'), createElement: tag => new El(tag), body: new El('body'),
  baseURI: 'file:///app/index.html', hidden: false,
  addEventListener: (type, fn) => (docListeners[type] ||= []).push(fn)
};
globalThis.window = globalThis;
window.self = window.top = globalThis;
window.addEventListener = (type, fn) => (winListeners[type] ||= []).push(fn);
window.isSecureContext = true;
window.devicePixelRatio = 2;
globalThis.location = { hostname: 'localhost', origin: 'http://localhost' };
globalThis.ResizeObserver = class { observe() {} };
let rafCount = 0;
globalThis.requestAnimationFrame = () => ++rafCount;
Object.defineProperty(globalThis, 'Event', { configurable: true, writable: true, value: class { constructor(type) { this.type = type; } } });

let clock = 1000;
Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: { now: () => clock } });

const store = new Map();
let storageThrows = false;
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => { if (storageThrows) throw new Error('QuotaExceededError'); store.set(key, String(value)); },
  removeItem: key => store.delete(key)
};

const param = () => ({ value: 0, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} });
const node = extra => ({ connect() {}, disconnect() {}, ...extra });
const oscillators = [];
const gains = [];
let gumCalls = 0;
let ctx = null;
class FakeContext {
  constructor() { ctx = this; this.sampleRate = 48000; this.state = 'suspended'; this.currentTime = 0; this.destination = node(); this.audioWorklet = { addModule: async () => {} }; }
  async resume() { this.state = 'running'; this.onstatechange?.(); }
  async suspend() { this.state = 'suspended'; this.onstatechange?.(); }
  createOscillator() { const o = node({ frequency: param(), detune: param(), start() {}, type: 'sine' }); oscillators.push(o); return o; }
  createGain() { const g = node({ gain: param() }); gains.push(g); return g; }
  createBiquadFilter() { return node({ frequency: param(), Q: param(), type: '' }); }
  createDelay() { return node({ delayTime: param() }); }
  createConvolver() { return node({}); }
  createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
  createConstantSource() { return node({ offset: param(), start() {} }); }
  createMediaStreamDestination() { return node({ stream: {} }); }
  createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  createMediaStreamSource() { return node(); }
  createAnalyser() { return node({ fftSize: 2048, frequencyBinCount: 1024, getFloatTimeDomainData() {}, getFloatFrequencyData(a) { a.fill(-120); } }); }
}
window.AudioContext = FakeContext;
const worklets = [];
window.AudioWorkletNode = class { constructor() { this.port = { onmessage: null }; worklets.push(this); } connect() {} };

const midiIn = { id: 'in-1', name: 'Keys', state: 'connected', onmidimessage: null };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: {
    mediaDevices: { getUserMedia: async () => { gumCalls++; await new Promise(r => setTimeout(r, 20)); return { getTracks: () => [] }; } },
    serviceWorker: { register: async () => {} },
    requestMIDIAccess: async () => ({ inputs: new Map([[midiIn.id, midiIn]]), outputs: new Map() })
  }
});

const recorders = [];
window.MediaRecorder = class {
  constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = ''; recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
};

const recognizers = [];
window.SpeechRecognition = class {
  constructor() { this.starts = 0; this.aborted = false; recognizers.push(this); }
  start() { this.starts++; }
  abort() { this.aborted = true; }
};

await import('../src/app.js');

const tick = ms => new Promise(r => setTimeout(r, ms));
const osc = () => oscillators[0];
const voiceGain = () => gains[0];
const voice = (hz, amp = 0.3, n = 2048) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) for (let h = 1; h <= 8; h++) out[i] += (amp / h) * Math.sin(2 * Math.PI * hz * h * i / 48000 + h);
  return out;
};
const post = samples => { clock += 30; worklets[0].port.onmessage({ data: { type: 'window', samples } }); };

test('boots ready, with no fake pre-flight row and the shown preset applied', () => {
  assert.equal(els.systemVerdict.textContent, 'INSTRUMENT READY');
  assert.equal(els.startButton.disabled, false);
  assert.ok(els.mappingRows.innerHTML.includes('No modulation mappings'), 'Classic has no mappings, and the matrix matches it');
  assert.ok(docListeners.visibilitychange?.length, 'visibilitychange is handled');
  assert.ok(winListeners.pagehide?.length, 'pagehide stops MIDI output');
  assert.equal(els.scope.width, 2320, 'canvas backing store follows CSS size times DPR');
});

test('Record before Start says so instead of blaming the browser', () => {
  els.recordButton.fire('click');
  assert.equal(els.recordingStatus.textContent, 'Start the instrument first.');
});

test('a double click on Start opens one mic stream, one worklet and one loop', async () => {
  els.startButton.fire('click');
  assert.equal(els.startButton.disabled, true);
  els.startButton.fire('click');
  await tick(80);
  assert.equal(gumCalls, 1);
  assert.equal(worklets.length, 1);
  assert.equal(rafCount, 1);
  assert.equal(els.audioStatus.textContent, 'running');
  assert.ok(els.audioDot.classList.contains('on'));
});

test('worklet windows reach the shared detector and land on the note without a glide', () => {
  post(voice(220));
  assert.equal(els.noteReadout.textContent, 'A3');
  assert.ok(Math.abs(osc().detune.value - -1200) < 20, `detune ${osc().detune.value}`);
  assert.ok(voiceGain().gain.value > 0);
});

test('the feedback guard probes after 3 s of unbroken voice and trips when the level collapses', () => {
  for (let t = 0; t < 3000; t += 30) post(voice(220));
  assert.equal(voiceGain().gain.value, 0, 'probe mutes the synth');
  post(voice(220, 0.02));
  assert.match(els.confidenceReadout.textContent, /feedback/);
  assert.equal(voiceGain().gain.value, 0);
  for (let t = 0; t < 1200; t += 30) post(new Float32Array(2048));
  post(voice(329.63));
  assert.ok(voiceGain().gain.value > 0, 'rearms after a second of quiet');
  assert.equal(els.noteReadout.textContent, 'E4');
});

test('hiding the tab suspends audio and ignores windows; showing it resumes', async () => {
  document.hidden = true;
  for (const fn of docListeners.visibilitychange) fn();
  await tick(0);
  assert.equal(ctx.state, 'suspended');
  assert.equal(els.audioStatus.textContent, 'suspended');
  post(voice(440));
  assert.equal(els.noteReadout.textContent, 'E4', 'a hidden tab does not play');
  document.hidden = false;
  for (const fn of docListeners.visibilitychange) fn();
  await tick(0);
  assert.equal(ctx.state, 'running');
});

test('MIDI override plays a key as it arrives, not at the next analysis frame', async () => {
  els.midiConnect.fire('click');
  await tick(0);
  els.midiInput.value = 'in-1';
  els.midiInput.fire('change');
  els.midiInputOverride.checked = true;
  els.midiInputOverride.fire('change');
  midiIn.onmidimessage({ data: [0x90, 72, 100] });
  assert.equal(osc().detune.value, 300);
  assert.equal(els.noteReadout.textContent, 'C5');
  midiIn.onmidimessage({ data: [0x80, 72, 0] });
  assert.equal(voiceGain().gain.value, 0);
  els.midiInputOverride.checked = false;
  els.midiInputOverride.fire('change');
});

test('a fatal speech error stops recognition instead of restart-looping', async () => {
  els.speechToggle.checked = true;
  els.speechToggle.fire('change');
  const rec = recognizers.at(-1);
  rec.onerror({ error: 'not-allowed' });
  rec.onend?.();
  await tick(600);
  assert.equal(rec.starts, 1);
  assert.equal(els.speechToggle.checked, false);
  assert.equal(els.speechStatus.textContent, 'Spoken commands stopped: not-allowed');
});

test('speech handles every new final result from resultIndex, with straight quotes', async () => {
  els.speechToggle.checked = true;
  els.speechToggle.fire('change');
  const rec = recognizers.at(-1);
  const result = text => Object.assign([{ transcript: text }], { isFinal: true });
  rec.onresult({ resultIndex: 1, results: [result('wave square'), result('more reverb'), result('wave saw')] });
  assert.equal(els.reverbMix.value, 38);
  assert.equal(els.waveform.value, 'sawtooth');
  assert.equal(els.speechStatus.textContent, 'Heard: "wave saw"');
  // Replacing a recognizer aborts the old one, and its onend no longer restarts anything.
  els.speechToggle.fire('change');
  assert.equal(rec.aborted, true);
  assert.equal(rec.onend, null);
});

test('calibration finishes and unmutes when storage is blocked', async () => {
  storageThrows = true;
  els.calibrationButton.fire('click');
  assert.equal(els.calibrationButton.disabled, true);
  for (let i = 0; i < 10; i++) post(new Float32Array(2048).fill(0.001));
  await tick(2100);
  storageThrows = false;
  assert.equal(els.calibrationButton.disabled, false);
  assert.match(els.calibrationStatus.textContent, /not saved/);
  post(voice(220));
  assert.ok(voiceGain().gain.value > 0, `the synth plays again: ${els.confidenceReadout.textContent} ${els.calibrationStatus.textContent}`);
});

test('an oversized preset file is refused before it is read', async () => {
  let read = false;
  els.presetFile.files = [{ size: 300 * 1024, name: 'big.json', text: async () => { read = true; return '{}'; } }];
  els.presetFile.fire('change');
  await tick(0);
  assert.equal(read, false);
  assert.equal(els.presetStatus.textContent, 'Preset file is too large (256 KB maximum).');
});

test('a failed plugin load shows why and lets the user retry', async () => {
  els.loadSandboxPlugin.fire('click');
  assert.equal(els.loadSandboxPlugin.disabled, true, 'disabled before the await');
  await tick(0);
  assert.equal(els.loadSandboxPlugin.disabled, false);
  assert.equal(els.loadSandboxPlugin.textContent, 'Load failed, retry');
  assert.match(els.pluginStatus.textContent, /same-origin/);
});

test('a recorder error mid-take resets the buttons and says why', () => {
  els.recordButton.fire('click');
  assert.equal(els.stopRecord.disabled, false);
  const rec = recorders.at(-1);
  rec.state = 'inactive';
  rec.onerror({ error: new Error('device lost') });
  assert.equal(els.stopRecord.disabled, true);
  assert.equal(els.recordButton.disabled, false);
  assert.equal(els.recordingStatus.textContent, 'Recording stopped: device lost');
});
