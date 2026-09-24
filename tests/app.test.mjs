// Loads the real src/app.js against a small DOM, Web Audio, MIDI and speech
// shim and drives it the way a user and the audio thread would. The tests run
// in order and share one app instance, because app.js wires itself on import.
import { test, mock } from 'node:test';
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
    Object.assign(this, { classList: new ClassList(), dataset: {}, style: {}, handlers: {}, width: 1200, height: 360, clientWidth: 1160, clientHeight: 330, min: '0', max: '100', step: '' });
    this.events = [];
  }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  dispatchEvent(event) { this.events.push(event); for (const fn of this.handlers[event.type] || []) fn(event); }
  fire(type, extra = {}) { this.dispatchEvent({ type, target: this, ...extra }); }
  querySelector() { return new El('q'); }
  querySelectorAll() { return []; }
  closest() { return null; }
  getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }
  click() { this.fire('click'); }
  appendChild() {} remove() {} setAttribute() {}
}

const els = {};
const initial = {
  glide: '45', quantizeStrength: '100', filterCutoff: '4200', delayMix: '18', reverbMix: '28', outputGain: '65', waveform: 'sine', pitchMode: 'free',
  scaleSelect: 'minor', rootSelect: 'D', customScaleCents: '0, 200, 300',
  referenceA4: '440', freeHysteresis: '0', attack: '54', release: '105', loudnessCurve: '0.72',
  loopBpm: '96', loopBeats: '4', loopBars: '1', loopLevel: '80', clickLevel: '50', loopNudge: '0', midiLearnTarget: 'filter'
};
// Range attributes the MIDI learn tests need, as index.html sets them.
const attrs = {
  filterCutoff: { min: '150', max: '12000' }, glide: { min: '0', max: '500' }, referenceA4: { min: '430', max: '450', step: '0.1' },
  attack: { min: '1', max: '500' }, release: { min: '5', max: '2000' }, loudnessCurve: { min: '0.25', max: '2.5', step: '0.01' },
  freeHysteresis: { min: '0', max: '25' }, delayMix: { min: '0', max: '70' }, reverbMix: { min: '0', max: '80' }
};
const docListeners = {};
const winListeners = {};
globalThis.document = {
  getElementById: id => (els[id] ||= Object.assign(new El(id), attrs[id] || {}, initial[id] !== undefined ? { value: initial[id] } : {})),
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
let rafCallback = null;
globalThis.requestAnimationFrame = fn => { rafCallback = fn; return ++rafCount; };
Object.defineProperty(globalThis, 'Event', { configurable: true, writable: true, value: class { constructor(type, init = {}) { this.type = type; this.bubbles = Boolean(init.bubbles); } } });

let clock = 1000;
Object.defineProperty(globalThis, 'performance', { configurable: true, writable: true, value: { now: () => clock } });

const store = new Map();
// Planted before import: a prototype name and a binding for a plugin that is
// not loaded.
store.set('voxctl.midiLearn.v0.4', '[{"cc":5,"param":"constructor"},{"cc":20,"param":"plugin:sandbox-lfo:rate"}]');
let storageThrows = false;
globalThis.localStorage = {
  getItem: key => store.get(key) ?? null,
  setItem: (key, value) => { if (storageThrows) throw new Error('QuotaExceededError'); store.set(key, String(value)); },
  removeItem: key => store.delete(key)
};

const param = () => ({
  value: 0, tau: null, calls: [],
  setTargetAtTime(v, t, tau) { this.value = v; this.tau = tau; this.calls.push(['target', v, t, tau]); },
  setValueAtTime(v, t) { this.value = v; this.calls.push(['set', v, t]); },
  cancelScheduledValues() {}
});
const node = extra => ({ connect() {}, disconnect() {}, ...extra });
const oscillators = [];
const gains = [];
const bufferSources = [];
let decodeSeconds = 2.8;
let decodes = 0;
let gumCalls = 0;
let ctx = null;
class FakeContext {
  constructor() { ctx = this; this.sampleRate = 48000; this.state = 'suspended'; this.destination = node(); this.audioWorklet = { addModule: async () => {} }; }
  // The audio clock follows the fake performance clock, so the engine's
  // level model and the looper's scheduler see time pass.
  get currentTime() { return clock / 1000; }
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
  createBuffer(channels, length, rate = 48000) { const data = new Float32Array(length); return { length, sampleRate: rate, duration: length / rate, getChannelData: () => data }; }
  createBufferSource() {
    const s = node({ buffer: null, loop: false, loopStart: 0, playbackRate: param(), startAt: null, stopAt: null, onended: null });
    s.out = [];
    s.connect = target => { s.out.push(target); };
    s.start = t => { s.startAt = t; };
    s.stop = (t = this.currentTime) => { s.stopAt = t; };
    bufferSources.push(s);
    return s;
  }
  async decodeAudioData() { decodes++; return this.createBuffer(1, Math.round(decodeSeconds * 48000)); }
  createMediaStreamSource() { return node(); }
  createAnalyser() { return node({ fftSize: 2048, frequencyBinCount: 1024, getFloatTimeDomainData() {}, getFloatFrequencyData(a) { a.fill(-120); } }); }
}
window.AudioContext = FakeContext;
const worklets = [];
window.AudioWorkletNode = class { constructor() { this.port = { onmessage: null }; worklets.push(this); } connect() {} };

const midiIn = { id: 'in-1', name: 'Keys', state: 'connected', onmidimessage: null };
const midiOut = { id: 'out-1', name: 'Synth', state: 'connected', sent: [], send(data) { this.sent.push([...data]); } };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: {
    mediaDevices: { getUserMedia: async () => { gumCalls++; await new Promise(r => setTimeout(r, 20)); return { getTracks: () => [] }; } },
    serviceWorker: { register: async () => {} },
    requestMIDIAccess: async () => ({ inputs: new Map([[midiIn.id, midiIn]]), outputs: new Map([[midiOut.id, midiOut]]) })
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

test('the looper refuses before Start, like Record', () => {
  els.transportButton.fire('click');
  assert.equal(els.recordingStatus.textContent, 'Start the instrument first.');
  els.recordingStatus.textContent = '';
  els.playLoop.fire('click');
  assert.equal(els.recordingStatus.textContent, 'Start the instrument first.');
  els.recordingStatus.textContent = '';
  els.syncRecord.checked = true;
  els.recordButton.fire('click');
  assert.equal(els.recordingStatus.textContent, 'Start the instrument first.');
  els.syncRecord.checked = false;
  assert.equal(els.recordButton.disabled, true);
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

// v0.4.0: MIDI learn, the Feel controls, the latency estimate, the looper
// and preset bindings. These share the running instance from the tests above.

const LEARN_KEY = 'voxctl.midiLearn.v0.4';
const cc = (n, v) => midiIn.onmidimessage({ data: [0xb0, n, v] });
const quiet = (n = 3) => { for (let i = 0; i < n; i++) post(new Float32Array(2048)); };
const sing = (hz, n = 3) => { for (let i = 0; i < n; i++) post(voice(hz)); };
// Moves the audio clock and lets LoopEngine's real 25 ms interval run. Steps
// stay inside the 120 ms lookahead, because the scheduler drops beats that
// are already in the past rather than playing them late.
const advance = async ms => {
  for (let left = ms; left > 0; left -= 100) { clock += Math.min(100, left); await tick(30); }
};
const sentSince = mark => midiOut.sent.slice(mark);
const loopBus = () => gains[6];
const clickBus = () => gains[7];
const speak = text => recognizers.at(-1).onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
const stopTempo = () => { if (els.transportButton.textContent === 'Stop tempo') els.transportButton.fire('click'); };

test('stored bindings are validated at boot and survive every factory preset load', () => {
  assert.doesNotMatch(els.midiLearnList.innerHTML, /CC5 /, 'a prototype name is dropped');
  assert.match(els.midiLearnList.innerHTML, /CC20 -> sandbox-lfo rate \(plugin not loaded\)/);
  const stored = store.get(LEARN_KEY);
  for (const id of ['factory:classic', 'factory:magnetic', 'factory:space-choir', 'factory:quarter-tone']) {
    els.presetSelect.value = id;
    els.loadPreset.fire('click');
    assert.match(els.midiLearnList.innerHTML, /CC20 /, id);
  }
  assert.equal(store.get(LEARN_KEY), stored);
  els.presetSelect.value = 'factory:classic';
  els.loadPreset.fire('click');
  assert.match(els.midiLearnTarget.innerHTML, /value="referenceA4">Reference A4</);
});

test('a CC bound to a prototype name or an unloaded plugin changes nothing', async () => {
  const before = els.filterCutoff.events.length;
  assert.doesNotThrow(() => { cc(5, 100); cc(20, 64); });
  await tick(30);
  assert.equal(els.filterCutoff.events.length, before);
  assert.match(els.midiStatus.textContent, /^CC20: 64 -> sandbox-lfo rate \(plugin not loaded\)$/);
});

test('MIDI learn binds the next CC, which then drives the slider through its input event', async () => {
  els.midiLearnTarget.value = 'filter';
  els.midiLearnArm.fire('click');
  assert.equal(els.midiLearnArm.textContent, 'Cancel learn');
  const before = els.filterCutoff.value;
  cc(74, 127);
  await tick(30);
  assert.equal(els.filterCutoff.value, before, 'the arming message is not applied');
  assert.match(els.midiStatus.textContent, /^Learned CC74 -> Filter cutoff\.$/);
  assert.equal(els.midiLearnArm.textContent, 'Learn CC');
  cc(74, 127);
  await tick(30);
  assert.equal(els.filterCutoff.value, '12000');
  assert.equal(els.filterValue.textContent, '12000 Hz');
  assert.deepEqual(JSON.parse(store.get(LEARN_KEY)), [{ cc: 20, param: 'plugin:sandbox-lfo:rate' }, { cc: 74, param: 'filter' }]);
});

test('a burst of CCs in one 16 ms window dispatches one input event', async () => {
  const before = els.filterCutoff.events.length;
  for (let i = 0; i < 50; i++) cc(74, i);
  await tick(30);
  assert.equal(els.filterCutoff.events.length - before, 1);
  assert.equal(els.filterCutoff.value, '4722');
});

test('a panic CC never binds, and a forgotten arm times out after 15 s', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    els.midiLearnTarget.value = 'glide';
    els.midiLearnArm.fire('click');
    cc(123, 0);
    assert.equal(els.midiLearnArm.textContent, 'Cancel learn', 'still armed');
    assert.ok(!JSON.parse(store.get(LEARN_KEY)).some(b => b.cc === 123));
    mock.timers.tick(15000);
    assert.equal(els.midiLearnArm.textContent, 'Learn CC');
    assert.equal(els.midiStatus.textContent, 'MIDI learn timed out.');
  } finally { mock.timers.reset(); }
});

test('CCs never reach the MIDI override tail, so they cannot mute the voice or retrigger MIDI out', async () => {
  els.midiOutput.value = 'out-1';
  els.midiOutput.fire('change');
  els.midiOutputToggle.checked = true;
  els.midiInputOverride.checked = true;
  els.midiInputOverride.fire('change');
  quiet();
  sing(220);
  assert.ok(voiceGain().gain.value > 0);
  assert.ok(midiOut.sent.some(m => m[0] === 0x90 && m[1] === 57));
  const mark = midiOut.sent.length;
  cc(74, 10); cc(30, 5); cc(74, 90); cc(7, 3);
  await tick(30);
  assert.ok(voiceGain().gain.value > 0, 'voice still sounding');
  sing(220, 1);
  assert.deepEqual(sentSince(mark).filter(m => m[0] === 0x80 || m[0] === 0x90), [], 'no note-off, no retrigger');
  els.midiInputOverride.checked = false;
  els.midiInputOverride.fire('change');
  quiet();
});

test('the A4 reference retunes the oscillator base; quantized notes, the tuner and MIDI out follow it', () => {
  els.pitchMode.value = 'quantized';
  els.referenceA4.value = '432';
  els.referenceA4.fire('input');
  assert.equal(els.referenceA4Value.textContent, '432.0 Hz');
  assert.equal(osc().frequency.value, 432);
  quiet();
  sing(440);
  assert.equal(els.noteReadout.textContent, 'A4', 'quantized after the tuner');
  assert.match(els.tunerReadout.textContent, /^A4 \+3[12] ¢$/, 'the tuner shows the raw error against 432');
  const mark = midiOut.sent.length;
  els.referenceA4.value = '440';
  els.referenceA4.fire('input');
  sing(440);
  assert.equal(osc().frequency.value, 440);
  assert.deepEqual(sentSince(mark).filter(m => m[0] === 0x80 || m[0] === 0x90), [], 'the sounding note stays 69');
  els.pitchMode.value = 'free';
  els.midiOutputToggle.checked = false;
  els.midiOutputToggle.fire('change');
  quiet();
});

test('a reference change under MIDI override moves the base and schedules nothing on detune', () => {
  els.midiInputOverride.checked = true;
  els.midiInputOverride.fire('change');
  midiIn.onmidimessage({ data: [0x90, 72, 100] });
  const n = osc().detune.calls.length;
  els.referenceA4.value = '435';
  els.referenceA4.fire('input');
  assert.equal(osc().frequency.value, 435);
  assert.equal(osc().detune.calls.length, n);
  midiIn.onmidimessage({ data: [0x80, 72, 0] });
  els.midiInputOverride.checked = false;
  els.midiInputOverride.fire('change');
  els.referenceA4.value = '440';
  els.referenceA4.fire('input');
});

test('the tuner comes before free-mode hysteresis, and clears on silence and below the gate', () => {
  els.freeHysteresis.value = '25';
  els.freeHysteresis.fire('input');
  assert.equal(els.freeHysteresisValue.textContent, '25 ¢');
  quiet();
  sing(440, 4);
  assert.equal(els.noteReadout.textContent, 'A4');
  sing(440 * 2 ** (13 / 1200), 4);
  assert.equal(els.noteReadout.textContent, 'A4', 'the hold keeps the old pitch');
  assert.match(els.tunerReadout.textContent, /^A4 \+1[234] ¢$/, 'the tuner still shows the move');
  quiet(1);
  assert.equal(els.tunerReadout.textContent, '-- ¢');
  assert.equal(els.tunerNeedle.style.left, '50%');
  post(voice(440, 0.0005));
  assert.equal(els.tunerReadout.textContent, '-- ¢', 'below the noise gate');
  els.freeHysteresis.value = '0';
  els.freeHysteresis.fire('input');
});

test('a long release follows note ends, but calibration mutes on the fast path and refuses the looper', async () => {
  els.release.value = '2000';
  els.release.fire('input');
  assert.equal(els.releaseValue.textContent, '2000 ms');
  quiet();
  sing(220, 2);
  quiet(1);
  assert.ok(Math.abs(voiceGain().gain.tau - 2 / 3) < 1e-9, `release tau ${voiceGain().gain.tau}`);
  els.calibrationButton.fire('click');
  post(voice(220));
  assert.equal(els.tunerReadout.textContent, '-- ¢', 'no tuner while calibrating');
  assert.equal(voiceGain().gain.value, 0);
  assert.equal(voiceGain().gain.tau, 0.035);
  for (const button of [els.recordButton, els.transportButton, els.playLoop]) {
    els.recordingStatus.textContent = '';
    button.fire('click');
    assert.equal(els.recordingStatus.textContent, 'Calibrating; wait for it to finish.', button.id);
  }
  for (let i = 0; i < 20; i++) post(new Float32Array(2048).fill(0.001));
  await tick(2100);
  assert.equal(els.calibrationButton.disabled, false);
});

test('with a 2 s release the guard probe still mutes at the fast constant, through a reference change', () => {
  clock += 25000;
  quiet(3);
  for (let t = 0; t < 3100; t += 30) post(voice(220));
  assert.equal(voiceGain().gain.value, 0, 'probe mutes');
  assert.equal(voiceGain().gain.tau, 0.035, 'at the mute constant, not the release');
  els.referenceA4.value = '445';
  els.referenceA4.fire('input');
  post(voice(220));
  assert.equal(voiceGain().gain.value, 0);
  assert.equal(voiceGain().gain.tau, 0.035);
  els.referenceA4.value = '440';
  els.referenceA4.fire('input');
  quiet(40);
  els.release.value = '105';
  els.release.fire('input');
});

test('the latency estimate marks unreported parts and skips gaps in the cadence', () => {
  quiet(20);
  clock += 5000;
  quiet(1);
  rafCallback(clock);
  assert.ok(els.latencyTotal.textContent.endsWith(' +'), els.latencyTotal.textContent);
  assert.ok(els.latencyParts.innerHTML.includes('not reported'));
  assert.ok(els.latencyParts.innerHTML.includes('<span>Analysis wait (half cadence)</span><strong>15.0 ms</strong>'), els.latencyParts.innerHTML);
  assert.ok(els.latencyParts.innerHTML.includes('<span>Pitch window (half)</span><strong>21.3 ms</strong>'));
  assert.match(els.latencyUncounted.textContent, /^Not counted: glide 45 ms, attack 54 ms/);
});

test('a grid take waits a one-bar count-in, records, auto-stops and loops on the loop bus', async () => {
  els.syncRecord.checked = true;
  decodeSeconds = 2.8;
  const n = recorders.length;
  const clicksBefore = bufferSources.length;
  els.recordButton.fire('click');
  assert.equal(recorders.length, n, 'no recorder during the count-in');
  assert.match(els.recordingStatus.textContent, /^Count-in/);
  assert.equal(els.loopBpm.disabled, true, 'tempo locked while the transport runs');
  assert.equal(els.transportButton.textContent, 'Stop tempo');
  assert.equal(els.recordButton.disabled, true);
  assert.equal(els.stopRecord.disabled, false);
  await advance(2380);
  assert.equal(recorders.length, n);
  await advance(100);
  assert.equal(recorders.length, n + 1, 'the recorder starts in the pre-roll');
  const clicks = bufferSources.slice(clicksBefore);
  assert.ok(clicks.length >= 4, 'the count-in clicks with the metronome off');
  assert.ok(clicks.every(s => s.out.length === 1 && s.out[0] === clickBus()), 'clicks only reach the click bus');
  await advance(2800);
  await tick(20);
  assert.match(els.recordingStatus.textContent, /On the grid; ready to loop\.$/);
  assert.equal(els.playLoop.disabled, false);
  assert.equal(els.recordButton.disabled, false);
  els.playLoop.fire('click');
  const loop = bufferSources.at(-1);
  assert.equal(loop.loop, true);
  assert.deepEqual(loop.out, [loopBus()]);
  assert.equal(loop.playbackRate.value, 1, 'a grid take trims, no transposition');
  assert.match(els.recordingStatus.textContent, /^Loop starts on the next bar/);
  assert.equal(els.stopLoop.disabled, false);
});

test('hiding the tab stops the loop and the transport, and showing it does not restart them', async () => {
  const loop = bufferSources.filter(s => s.loop).at(-1);
  document.hidden = true;
  for (const fn of docListeners.visibilitychange) fn();
  await tick(0);
  assert.equal(els.recordingStatus.textContent, 'Loop stopped because the tab was hidden.');
  assert.notEqual(loop.stopAt, null);
  assert.equal(els.transportButton.textContent, 'Start tempo');
  assert.equal(els.stopLoop.disabled, true);
  document.hidden = false;
  for (const fn of docListeners.visibilitychange) fn();
  await advance(100);
  assert.equal(els.transportButton.textContent, 'Start tempo');
  assert.equal(els.loopBpm.disabled, false);
});

test('every stop path cancels a count-in, and no recorder is ever created', async () => {
  const paths = {
    'stop button': () => els.stopRecord.fire('click'),
    'speech': () => speak('stop recording'),
    'stop tempo': () => els.transportButton.fire('click'),
    'calibration': async () => {
      els.calibrationButton.fire('click');
      for (let i = 0; i < 20; i++) post(new Float32Array(2048).fill(0.001));
      await tick(2100);
    },
    'hidden tab': async () => {
      document.hidden = true;
      for (const fn of docListeners.visibilitychange) fn();
      document.hidden = false;
      for (const fn of docListeners.visibilitychange) fn();
      await tick(0);
    }
  };
  els.syncRecord.checked = true;
  for (const [name, cancel] of Object.entries(paths)) {
    const n = recorders.length;
    els.recordButton.fire('click');
    assert.match(els.recordingStatus.textContent, /^Count-in/, name);
    await cancel();
    await advance(3000);
    assert.equal(recorders.length, n, `${name}: no recorder`);
    assert.equal(els.recordButton.disabled, false, `${name}: Record is free again`);
    stopTempo();
  }
});

test('Stop in the pre-roll keeps the take downloadable and says it cannot loop', async () => {
  els.syncRecord.checked = true;
  const n = recorders.length;
  els.recordButton.fire('click');
  await advance(2480);
  assert.equal(recorders.length, n + 1);
  decodeSeconds = 0.05;
  els.stopRecord.fire('click');
  await tick(20);
  assert.match(els.recordingStatus.textContent, /Take ended before the first bar\.$/);
  assert.equal(els.downloadRecording.disabled, false);
  stopTempo();
  els.syncRecord.checked = false;
});

test('speech cannot start a second recorder during a count-in, and Stop ends the clicks it started', async () => {
  els.metronomeToggle.checked = true;
  els.metronomeToggle.fire('change');
  els.syncRecord.checked = true;
  const n = recorders.length;
  els.recordButton.fire('click');
  assert.equal(els.transportButton.textContent, 'Stop tempo');
  els.syncRecord.checked = false;
  speak('record');
  assert.equal(recorders.length, n, 'the grid take owns the recorder');
  els.stopRecord.fire('click');
  await tick(10);
  assert.equal(els.transportButton.textContent, 'Start tempo');
  const clicks = bufferSources.length;
  await advance(1000);
  assert.equal(bufferSources.length, clicks, 'no clicks after the cancel');
  assert.equal(recorders.length, n);
  els.metronomeToggle.checked = false;
  els.metronomeToggle.fire('change');
});

test('tempo inputs are clamped and written back, locked while running and freed by Stop tempo', () => {
  els.loopBpm.value = '300.6';
  els.loopBeats.value = '3.4';
  els.loopBars.value = '0';
  els.transportButton.fire('click');
  assert.deepEqual([els.loopBpm.value, els.loopBeats.value, els.loopBars.value], ['240', '3', '1']);
  assert.equal(els.recordingStatus.textContent, 'Tempo 240 BPM, 3 beats per bar.');
  assert.ok([els.loopBpm, els.loopBeats, els.loopBars].every(el => el.disabled));
  els.transportButton.fire('click');
  assert.ok([els.loopBpm, els.loopBeats, els.loopBars].every(el => !el.disabled));
  els.loopBpm.value = '96';
  els.loopBeats.value = '4';
});

test('a free take far longer than any loop is not decoded', async () => {
  const before = decodes;
  els.recordButton.fire('click');
  assert.equal(recorders.at(-1).state, 'recording', 'without the grid, Record starts at once as in 0.3.2');
  clock += 700000;
  els.stopRecord.fire('click');
  await tick(20);
  assert.equal(decodes, before);
  assert.match(els.recordingStatus.textContent, /This take is too long to loop; download it instead\.$/);
});

test('presets carry MIDI bindings only through the include toggle, and never reset tempo unasked', () => {
  const user = () => Object.values(JSON.parse(store.get('voxctl.presets.v0.3')));
  els.presetIncludeMidi.checked = false;
  els.presetName.value = 'NoMidi';
  els.savePreset.fire('click');
  const plain = user().find(p => p.name === 'NoMidi');
  assert.equal(plain.state.midiLearn, undefined);
  assert.equal(plain.state.bpm, 96);
  els.presetIncludeMidi.checked = true;
  els.presetName.value = 'WithMidi';
  els.savePreset.fire('click');
  assert.deepEqual(user().find(p => p.name === 'WithMidi').state.midiLearn, JSON.parse(store.get(LEARN_KEY)));

  const presetsRaw = JSON.parse(store.get('voxctl.presets.v0.3'));
  presetsRaw['user:zz1'] = { name: 'Pad', state: { bpm: 120, midiLearn: [{ cc: 3, param: 'glide' }] } };
  store.set('voxctl.presets.v0.3', JSON.stringify(presetsRaw));
  const bindings = store.get(LEARN_KEY);
  els.presetIncludeMidi.checked = false;
  els.presetSelect.value = 'user:zz1';
  els.loadPreset.fire('click');
  assert.match(els.presetStatus.textContent, /carries 1 MIDI binding; check Include MIDI learn bindings/);
  assert.equal(store.get(LEARN_KEY), bindings, 'unchanged with the toggle off');
  assert.equal(Number(els.loopBpm.value), 120);
  els.presetIncludeMidi.checked = true;
  els.loadPreset.fire('click');
  assert.match(els.presetStatus.textContent, /Loaded 1 MIDI binding\./);
  assert.deepEqual(JSON.parse(store.get(LEARN_KEY)), [{ cc: 3, param: 'glide' }]);
  els.presetSelect.value = 'factory:magnetic';
  els.loadPreset.fire('click');
  assert.equal(Number(els.loopBpm.value), 120, 'a factory preset keeps the user tempo');
  assert.deepEqual(JSON.parse(store.get(LEARN_KEY)), [{ cc: 3, param: 'glide' }]);
});
