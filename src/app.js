import { AudioEngine, ANALYSIS_MS, recordingExtension } from './audio/audio-engine.js';
import { PitchDetector } from './audio/pitch-detector.js';
import { FeatureEngine } from './audio/feature-engine.js';
import { CalibrationEngine } from './audio/calibration.js';
import { FeedbackGuard } from './audio/feedback-guard.js';
import { PitchTracker } from './mapping/pitch-tracker.js';
import { A4_DEFAULT, clampReference, centsOffset, hzToMidi, midiToHz, midiToNote, parseCustomScale, formatCustomScale } from './mapping/scales.js';
import { MappingEngine, MAPPING_SOURCES, MAPPING_DESTINATIONS } from './mapping/mapping-engine.js';
import { PresetManager, MAX_PRESET_BYTES } from './presets/preset-manager.js';
import { PluginHost } from './plugins/plugin-host.js';
import { MidiManager } from './midi/midi-manager.js';
import { MAX_LEARN_CC, PLUGIN_PARAM, isLearnable, sanitizeBindings, bindCc, unbindCc, ccToSliderValue, loadBindings, saveBindings } from './midi/midi-learn.js';
import { estimateLatency, estimateRoundTripSeconds } from './audio/latency.js';
import { LoopEngine, clampTempo } from './audio/loop-engine.js';

// GitHub Pages cannot send a frame-ancestors header and a meta CSP cannot set
// one, so refuse to run inside another site's frame, where a page could
// overlay Start, Record or Connect MIDI.
if (window.top !== window.self) {
  document.body.textContent = 'Open VoxCTL directly.';
  throw new Error('framed');
}

const $ = id => document.getElementById(id);
const ui = {
  startButton: $('startButton'), scope: $('scope'), note: $('noteReadout'), pitch: $('pitchReadout'), confidence: $('confidenceReadout'),
  meter: $('voiceMeter'), rms: $('rmsReadout'), pitchMode: $('pitchMode'), scale: $('scaleSelect'), root: $('rootSelect'),
  customScaleWrap: $('customScaleWrap'), customScaleCents: $('customScaleCents'), customScaleStatus: $('customScaleStatus'),
  quantize: $('quantizeStrength'), quantizeValue: $('quantizeValue'), glide: $('glide'), glideValue: $('glideValue'), waveform: $('waveform'),
  referenceA4: $('referenceA4'), referenceA4Value: $('referenceA4Value'), freeHysteresis: $('freeHysteresis'), freeHysteresisValue: $('freeHysteresisValue'),
  attack: $('attack'), attackValue: $('attackValue'), release: $('release'), releaseValue: $('releaseValue'),
  loudnessCurve: $('loudnessCurve'), loudnessCurveValue: $('loudnessCurveValue'), tunerNeedle: $('tunerNeedle'), tunerReadout: $('tunerReadout'),
  latencyTotal: $('latencyTotal'), latencyParts: $('latencyParts'), latencyUncounted: $('latencyUncounted'),
  filter: $('filterCutoff'), filterValue: $('filterValue'), delay: $('delayMix'), delayValue: $('delayValue'), reverb: $('reverbMix'),
  reverbValue: $('reverbValue'), output: $('outputGain'), outputValue: $('outputValue'), speechToggle: $('speechToggle'), speechStatus: $('speechStatus'),
  pluginList: $('pluginList'), loadGhostPlugin: $('loadGhostPlugin'), loadSandboxPlugin: $('loadSandboxPlugin'), pluginStatus: $('pluginStatus'),
  micDot: $('micDot'), audioDot: $('audioDot'), micStatus: $('micStatus'), audioStatus: $('audioStatus'),
  systemVerdict: $('systemVerdict'), systemCheckNote: $('systemCheckNote'), analysisStatus: $('analysisStatus'),
  calibrationButton: $('calibrationButton'), calibrationStatus: $('calibrationStatus'), noiseFloorReadout: $('noiseFloorReadout'), noiseGateReadout: $('noiseGateReadout'),
  brightnessReadout: $('brightnessReadout'), noisinessReadout: $('noisinessReadout'), centroidReadout: $('centroidReadout'), formantReadout: $('formantReadout'),
  vibratoReadout: $('vibratoReadout'), mappingRows: $('mappingRows'), addMapping: $('addMapping'), resetMappings: $('resetMappings'),
  presetSelect: $('presetSelect'), presetName: $('presetName'), savePreset: $('savePreset'), loadPreset: $('loadPreset'), deletePreset: $('deletePreset'),
  presetStatus: $('presetStatus'), exportPreset: $('exportPreset'), importPreset: $('importPreset'), presetFile: $('presetFile'), presetIncludeMidi: $('presetIncludeMidi'),
  midiConnect: $('midiConnect'), midiInput: $('midiInput'), midiOutput: $('midiOutput'), midiInputOverride: $('midiInputOverride'),
  midiOutputToggle: $('midiOutputToggle'), midiStatus: $('midiStatus'),
  midiLearnTarget: $('midiLearnTarget'), midiLearnArm: $('midiLearnArm'), midiLearnClear: $('midiLearnClear'), midiLearnList: $('midiLearnList'),
  recordButton: $('recordButton'), stopRecord: $('stopRecord'), recordingPlayer: $('recordingPlayer'),
  downloadRecording: $('downloadRecording'), recordingStatus: $('recordingStatus'),
  loopBpm: $('loopBpm'), loopBeats: $('loopBeats'), loopBars: $('loopBars'), metronomeToggle: $('metronomeToggle'), syncRecord: $('syncRecord'),
  transportButton: $('transportButton'), playLoop: $('playLoop'), stopLoop: $('stopLoop'),
  loopLevel: $('loopLevel'), loopLevelValue: $('loopLevelValue'), clickLevel: $('clickLevel'), clickLevelValue: $('clickLevelValue'),
  loopNudge: $('loopNudge'), loopNudgeValue: $('loopNudgeValue')
};

// Sliders a MIDI CC can drive. The keys must equal LEARNABLE in
// midi/midi-learn.js; tests/app-shell.test.mjs checks both.
const LEARN = {
  quantize: { el: ui.quantize, label: 'Quantize strength' },
  glide: { el: ui.glide, label: 'Glide' },
  referenceA4: { el: ui.referenceA4, label: 'Reference A4' },
  freeHysteresis: { el: ui.freeHysteresis, label: 'Free-mode hysteresis' },
  filter: { el: ui.filter, label: 'Filter cutoff' },
  delay: { el: ui.delay, label: 'Delay' },
  reverb: { el: ui.reverb, label: 'Reverb' },
  output: { el: ui.output, label: 'Output' },
  attack: { el: ui.attack, label: 'Attack' },
  release: { el: ui.release, label: 'Release' },
  loudnessCurve: { el: ui.loudnessCurve, label: 'Loudness curve' },
  loopLevel: { el: ui.loopLevel, label: 'Loop level' },
  clickLevel: { el: ui.clickLevel, label: 'Click level' }
};

const PLUGIN_BUTTONS = {
  'ghost-radio': { button: ui.loadGhostPlugin, label: 'Load Ghost Radio' },
  'sandbox-lfo': { button: ui.loadSandboxPlugin, label: 'Load Sandbox LFO' }
};

const engine = new AudioEngine();
// A device error mid-take ends the recorder; without this the UI stayed on "Recording".
engine.onRecordingError = error => {
  // The recorder is already gone, so a grid take is only dropped.
  loopEngine.cancelTake({ stopRecorder: false });
  loopEngine.consumeGrid();
  syncLooperUi();
  ui.recordingStatus.textContent = `Recording stopped: ${error?.message || 'recorder failed'}`;
};
const calibration = new CalibrationEngine();
const presets = new PresetManager();
const guard = new FeedbackGuard();
const tracker = new PitchTracker();
const mappingEngine = new MappingEngine([]);
const pluginHost = new PluginHost({
  setFilterOffset: value => engine.setPluginFilterOffset(value),
  setDetuneOffset: value => engine.setPluginDetuneOffset(value),
  setDelayOffset: value => engine.setPluginDelayOffset(value),
  setReverbOffset: value => engine.setPluginReverbOffset(value),
  setMasterOffset: value => engine.setPluginMasterOffset(value)
}, {
  // Fires when the host has already unloaded a plugin (message flood, or its
  // sandbox frame navigated), so the UI only has to catch up.
  onPluginError: (id, reason) => {
    renderPlugins();
    const entry = PLUGIN_BUTTONS[id];
    if (entry) resetPluginButton(entry.button, entry.label);
    ui.pluginStatus.textContent = reason;
  }
});

let detector = null;
let featureEngine = null;
let timeData = null;
let scopeCtx = null;
let running = false;
let starting = false;
let lastAnalysis = 0;
let recognition = null;
let workletActive = false;
let calibrating = false;
let noiseGate = 0.008;
let lastSignalAt = 0;
let customCentsCache = [0];
let midiState = { active: false, note: null, velocity: 0, pitchBend: 0, midi: null };
let recordingBlob = null;
let recordingUrl = null;
let referenceA4 = A4_DEFAULT;
// Smoothed gap between analysis frames, for the latency estimate.
let cadenceMs = 0;
let lastLatencyAt = 0;
let midiBindings = loadBindings();
let learnArm = null;
const pendingCc = new Map();
let ccTimer = 0;
const capabilityState = new Map();
const CALIBRATING_TEXT = 'Calibrating; wait for it to finish.';

const midiManager = new MidiManager({ onInput: handleMidiEvent });

// Every looper timer lives in LoopEngine: the count-in, the recorder start
// PREROLL before the take, and the auto-stop all run from its scheduler.
const loopEngine = new LoopEngine(engine, {
  hooks: {
    startRecorder: () => { beginRecording(); return engine.startCallTime; },
    stopRecorder: () => { stopRecording(); },
    compensation: takeCompensation,
    onStatus: text => { ui.recordingStatus.textContent = text; syncLooperUi(); }
  }
});

function setCapability(name, supported, detail = '') {
  capabilityState.set(name, Boolean(supported));
  const row = document.querySelector(`[data-capability="${name}"]`);
  if (!row) return;
  row.classList.toggle('supported', Boolean(supported));
  row.classList.toggle('unsupported', !supported);
  row.querySelector('.capability-icon').textContent = supported ? '✓' : '×';
  row.querySelector('.capability-status').textContent = detail || (supported ? 'ready' : 'unsupported');
}

function runCompatibilityCheck() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const speechSupported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  // Same condition as AudioEngine.supportsRecording: the recorder needs a MediaStreamDestination to tap.
  const recordingSupported = Boolean(window.MediaRecorder && AudioContextCtor?.prototype?.createMediaStreamDestination);
  setCapability('secure', window.isSecureContext || isLocalhost, (window.isSecureContext || isLocalhost) ? 'ready' : 'HTTPS required');
  setCapability('audio', Boolean(AudioContextCtor), AudioContextCtor ? 'ready' : 'unsupported');
  setCapability('mic', Boolean(navigator.mediaDevices?.getUserMedia), navigator.mediaDevices?.getUserMedia ? 'ready' : 'unavailable');
  setCapability('worklet', Boolean(window.AudioWorkletNode), window.AudioWorkletNode ? 'preferred path' : 'fallback available');
  setCapability('recording', recordingSupported, recordingSupported ? 'available' : 'optional / unsupported');
  setCapability('sw', 'serviceWorker' in navigator, 'serviceWorker' in navigator ? 'registering' : 'optional / unsupported');
  setCapability('speech', speechSupported, speechSupported ? 'available' : 'optional / unsupported');
  setCapability('midi', 'requestMIDIAccess' in navigator, 'requestMIDIAccess' in navigator ? 'available' : 'optional / unsupported');

  const failures = ['secure', 'audio', 'mic'].filter(name => !capabilityState.get(name));
  const ready = failures.length === 0;
  ui.systemVerdict.textContent = ready ? 'INSTRUMENT READY' : 'CORE CHECK FAILED';
  ui.systemVerdict.classList.toggle('ready', ready);
  ui.systemVerdict.classList.toggle('failed', !ready);
  ui.startButton.disabled = !ready;
  ui.systemCheckNote.textContent = ready
    ? 'Core audio is supported. Pitch runs on the main thread from AudioWorklet windows, or from an AnalyserNode if AudioWorklet is missing.'
    : `Cannot start: ${failures.join(', ')}. Use the GitHub Pages HTTPS URL in a current browser.`;
  if (!speechSupported) {
    ui.speechToggle.disabled = true;
    ui.speechStatus.textContent = 'Speech recognition is optional and unsupported by this browser.';
  }
  if (!capabilityState.get('midi')) ui.midiConnect.disabled = true;
}

async function startInstrument() {
  if (running || starting) return;
  // Disabled before the await: a second click during the mic prompt used to
  // start a second worklet and a second render loop.
  starting = true;
  ui.startButton.disabled = true;
  ui.startButton.textContent = 'Starting…';
  try {
    const context = await engine.start();
    context.onstatechange = showAudioState;
    showAudioState();
    detector = new PitchDetector(context.sampleRate, { noiseGate });
    featureEngine = new FeatureEngine(engine.analyser, context.sampleRate);
    timeData = new Float32Array(engine.analyser.fftSize);
    // Both paths hand raw windows to the same detector on this thread.
    workletActive = await engine.enableAnalysisWorklet(samples => processRawSignal(detector.detect(samples)));
    running = true;
    ui.startButton.textContent = 'Instrument running';
    ui.calibrationButton.disabled = false;
    applyLoopLevels();
    syncLooperUi();
    ui.micDot.classList.add('on');
    ui.micStatus.textContent = 'live';
    ui.analysisStatus.textContent = workletActive ? 'AudioWorklet windows · MPM' : 'main-thread fallback · MPM';
    requestAnimationFrame(loop);
  } catch (error) {
    console.error(error);
    ui.startButton.disabled = false;
    ui.startButton.textContent = 'Start instrument';
    ui.micStatus.textContent = startErrorText(error);
    ui.confidence.textContent = error.message;
    if (engine.context) { engine.context.onstatechange = showAudioState; showAudioState(); }
  } finally {
    starting = false;
  }
}

function startErrorText(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'permission denied';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'no microphone found';
  if (error?.name === 'NotReadableError') return 'microphone busy or unavailable';
  return 'unavailable';
}

// The context can be suspended or interrupted by the browser, the OS, or the
// visibility handler below, so the status follows the real state.
function showAudioState() {
  const state = engine.context?.state || 'suspended';
  ui.audioStatus.textContent = state;
  ui.audioDot.classList.toggle('on', state === 'running');
}

function loop(now) {
  if (!running || !engine.analyser) return;
  engine.analyser.getFloatTimeDomainData(timeData);
  drawScope(timeData);
  // The analyser buffer can be longer than the pitch window; read the newest samples.
  if (!workletActive && now - lastAnalysis >= ANALYSIS_MS) {
    lastAnalysis = now;
    processRawSignal(detector.detect(timeData.subarray(timeData.length - engine.windowSize)));
  }
  // Defensive mute if a worklet unexpectedly stops delivering windows.
  if (workletActive && lastSignalAt && performance.now() - lastSignalAt > 700 && !isMidiOverrideActive()) engine.mute();
  if (now - lastLatencyAt >= 500) { lastLatencyAt = now; renderLatency(); }
  requestAnimationFrame(loop);
}

// mute() is the fast safety path and release() the musical note end. The
// hidden-tab, calibration, stalled-worklet and feedback-guard paths must
// mute: with a 2 s release, a ramp would still be loud when the guard's
// 300 ms probe ends, and the guard could never see a speaker loop.
function processRawSignal(rawSignal) {
  // During a recording the context keeps running in a hidden tab, so the
  // worklet keeps posting. Nobody can hear or see the tab; stay silent.
  if (document.hidden) { engine.mute(); return; }
  const now = performance.now();
  // Gaps of 250 ms or more are a hidden tab or a stall, not the cadence.
  const gap = now - lastSignalAt;
  if (lastSignalAt && gap < 250) cadenceMs = cadenceMs ? cadenceMs * 0.8 + gap * 0.2 : gap;
  lastSignalAt = now;
  calibration.ingest(rawSignal);
  if (!featureEngine) return;

  const gated = { ...rawSignal, noiseGate };
  if (gated.rms < noiseGate) { gated.voiced = false; gated.pitchHz = 0; }
  const signal = featureEngine.enrich(gated);
  updateFeatureReadouts(signal);
  // Raw detector pitch, before the median, hysteresis and quantizing, so it
  // keeps showing the voice while MIDI override plays or the guard probes.
  renderTuner(calibrating ? null : signal);

  const meterPct = Math.round(clamp((signal.rms - noiseGate) / Math.max(0.02, 0.14 - noiseGate), 0, 1) * 100);
  ui.meter.style.width = `${meterPct}%`;
  ui.rms.textContent = `${meterPct}%`;

  if (calibrating) {
    engine.mute();
    engine.setMappingModulations({});
    midiManager.stopOutput();
    tracker.reset();
    pluginHost.notifySignal({ ...signal, voiced: false });
    ui.confidence.textContent = 'calibrating room noise…';
    return;
  }

  const mapping = mappingEngine.evaluate(signal);
  engine.setMappingModulations({
    filter: mapping['synth.filterCutoff'],
    detune: mapping['synth.detune'],
    delay: mapping['fx.delayMix'],
    reverb: mapping['fx.reverbMix'],
    master: mapping['master.gain']
  });

  // MIDI override drives pitch and level from the keyboard, so output no
  // longer follows the mic and the feedback guard has nothing to test.
  if (isMidiOverrideActive()) {
    pluginHost.notifySignal(signal);
    playMidiOverride();
    return;
  }

  const action = guard.update(now, signal);
  if (action !== 'play') {
    // Must be mute(), never release(): see the note above processRawSignal.
    engine.mute();
    midiManager.stopOutput();
    if (action === 'feedback') {
      tracker.reset();
      ui.confidence.textContent = 'feedback: the mic hears the synth, use headphones';
    }
    pluginHost.notifySignal({ ...signal, voiced: false });
    return;
  }

  pluginHost.notifySignal(signal);

  if (!signal.voiced || !signal.pitchHz) {
    engine.release();
    midiManager.stopOutput();
    tracker.reset();
    ui.note.textContent = '--';
    ui.pitch.textContent = '0.0 Hz';
    ui.confidence.textContent = signal.rms > noiseGate ? `no stable pitch · ${(signal.confidence * 100).toFixed(0)}%` : 'listening…';
    return;
  }

  const { midi, jump } = tracker.update(signal.pitchHz, {
    quantized: ui.pitchMode.value === 'quantized',
    root: ui.root.value,
    scale: ui.scale.value,
    customCents: customCentsCache,
    strength: Number(ui.quantize.value) / 100,
    referenceA4,
    hysteresisCents: Number(ui.freeHysteresis.value)
  });
  engine.setPitch(midi, Number(ui.glide.value), { jump });
  engine.setVoiceLevel(signal.rms, 0.72, noiseGate);
  // Detune mappings and plugins move the oscillator after quantizing; show
  // and send what actually sounds.
  const heard = midi + engine.getModulationCents() / 100;
  showPitch(heard);
  ui.confidence.textContent = `${(signal.confidence * 100).toFixed(0)}% confidence · MPM`;

  if (ui.midiOutputToggle.checked) {
    const level = clamp((signal.rms - noiseGate) / Math.max(0.04, 0.12 - noiseGate), 0, 1);
    midiManager.sendTheremin({ midi: heard, level, voiced: true });
  } else midiManager.stopOutput();
}

function playMidiOverride() {
  if (!running || !isMidiOverrideActive()) return;
  engine.setPitch(midiState.midi, Number(ui.glide.value));
  engine.setVoiceLevelNormalized(Math.max(0.04, midiState.velocity * 0.82));
  const heard = midiState.midi + engine.getModulationCents() / 100;
  showPitch(heard);
  ui.confidence.textContent = `MIDI input · bend ${(midiState.pitchBend * 2).toFixed(2)} st`;
  if (ui.midiOutputToggle.checked) midiManager.sendTheremin({ midi: heard, level: midiState.velocity, voiced: true });
  else midiManager.stopOutput();
}

function showPitch(midi) {
  ui.pitch.textContent = `${midiToHz(midi, referenceA4).toFixed(1)} Hz`;
  ui.note.textContent = displayNote(midi);
}

// Cents from the nearest equal-tempered semitone of the A4 reference. The
// note name and the cents round the same way, so at exactly +50 the name is
// the upper note and the cents read -50.
function renderTuner(signal) {
  if (!signal?.voiced || !signal.pitchHz) {
    ui.tunerReadout.textContent = '-- ¢';
    ui.tunerNeedle.style.left = '50%';
    ui.tunerNeedle.classList.toggle('in-tune', false);
    return;
  }
  const cents = Math.round(centsOffset(signal.pitchHz, referenceA4));
  ui.tunerNeedle.style.left = `${50 + cents}%`;
  ui.tunerNeedle.classList.toggle('in-tune', Math.abs(cents) <= 5);
  ui.tunerReadout.textContent = `${midiToNote(Math.round(hzToMidi(signal.pitchHz, referenceA4)))} ${cents >= 0 ? '+' : ''}${cents} ¢`;
}

function renderLatency() {
  const c = engine.context;
  const est = estimateLatency({ ...browserLatency(), cadenceMs });
  ui.latencyTotal.textContent = `${est.totalMs.toFixed(0)} ms${est.partial ? ' +' : ''}`;
  ui.latencyParts.innerHTML = est.parts.map(p =>
    `<div><span>${escapeHtml(p.label)}</span><strong>${p.ms === null ? 'not reported' : `${p.ms.toFixed(1)} ms`}</strong></div>`).join('');
  ui.latencyUncounted.textContent = `Not counted: glide ${Number(ui.glide.value)} ms, attack ${Number(ui.attack.value)} ms, and one analysis frame of pitch median on note changes.${c ? '' : ' Start the instrument for the browser values.'}`;
}

// What the browser reports about its own latency. The windowSize getter
// throws without a context.
function browserLatency() {
  const c = engine.context;
  const track = engine.stream?.getAudioTracks?.()[0];
  return {
    baseLatency: c?.baseLatency, outputLatency: c?.outputLatency, trackLatency: track?.getSettings?.().latency,
    sampleRate: c?.sampleRate, windowSize: c ? engine.windowSize : 0
  };
}

function isMidiOverrideActive() { return ui.midiInputOverride.checked && midiState.active && Number.isFinite(midiState.midi); }

function updateFeatureReadouts(signal) {
  ui.brightnessReadout.textContent = `${Math.round((signal.brightness || 0) * 100)}%`;
  ui.noisinessReadout.textContent = `${Math.round((signal.noisiness || 0) * 100)}%`;
  ui.centroidReadout.textContent = signal.spectralCentroid ? `${Math.round(signal.spectralCentroid)} Hz` : '--';
  ui.formantReadout.textContent = `${signal.formant1 ? Math.round(signal.formant1) : '--'} / ${signal.formant2 ? Math.round(signal.formant2) : '--'} Hz`;
  ui.vibratoReadout.textContent = signal.vibratoRate ? `${signal.vibratoRate.toFixed(1)} Hz · ${Math.round(signal.vibratoDepth)}¢` : '--';
}

async function calibrateRoom() {
  if (!running) { ui.calibrationStatus.textContent = 'Start the instrument first.'; return; }
  if (calibrating) return;
  // The click and a playing loop would raise the measured noise floor.
  const looperBusy = loopEngine.running || loopEngine.looping || loopEngine.takeState !== 'idle';
  if (looperBusy) { loopEngine.stopAll(); syncLooperUi(); }
  calibrating = true;
  ui.calibrationButton.disabled = true;
  ui.calibrationStatus.textContent = `${looperBusy ? 'Tempo and loop stopped for calibration. ' : ''}Remain quiet while the room baseline is measured…`;
  try {
    const result = await calibration.start(2000);
    noiseGate = result.noiseGate;
    detector?.configure({ noiseGate });
    renderCalibration(result);
    ui.calibrationStatus.textContent = result.persisted
      ? 'Room baseline saved locally.'
      : 'Room baseline applied for this session. Browser storage is blocked, so it was not saved.';
  } catch (error) {
    ui.calibrationStatus.textContent = error.message;
  } finally {
    calibrating = false;
    ui.calibrationButton.disabled = false;
  }
}

function renderCalibration(value) {
  if (!value) {
    ui.noiseFloorReadout.textContent = 'default';
    ui.noiseGateReadout.textContent = noiseGate.toFixed(4);
    return;
  }
  ui.noiseFloorReadout.textContent = value.noiseFloor.toFixed(4);
  ui.noiseGateReadout.textContent = value.noiseGate.toFixed(4);
}

// Match the canvas backing store to its displayed size so the trace stays
// sharp on high-DPI screens instead of stretching a fixed 1200x360 bitmap.
function sizeScope() {
  const dpr = window.devicePixelRatio || 1;
  ui.scope.width = Math.max(1, Math.round(ui.scope.clientWidth * dpr));
  ui.scope.height = Math.max(1, Math.round(ui.scope.clientHeight * dpr));
}

function drawScope(buffer) {
  const ctx = scopeCtx ||= ui.scope.getContext('2d');
  const w = ui.scope.width, h = ui.scope.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = '#090a0c'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#222833'; ctx.lineWidth = dpr;
  for (let i = 1; i < 6; i++) { const y = (h / 6) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.strokeStyle = '#e6ff5d'; ctx.lineWidth = 2 * dpr; ctx.beginPath();
  for (let i = 0; i < buffer.length; i++) {
    const x = i / (buffer.length - 1) * w;
    const y = h / 2 + buffer[i] * h * 0.42;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function applyBaseControls() {
  engine.setWaveform(ui.waveform.value);
  engine.setFilter(Number(ui.filter.value));
  engine.setDelayMix(Number(ui.delay.value) / 100);
  engine.setReverbMix(Number(ui.reverb.value) / 100);
  engine.setMaster(Number(ui.output.value) / 100);
  engine.setDynamics({ attackMs: Number(ui.attack.value), releaseMs: Number(ui.release.value), curve: Number(ui.loudnessCurve.value) });
  // The tracker shifts itself into the new reference on its next frame, so
  // a swept reference glides instead of jumping. The oscillator base steps
  // now; free-mode detune catches up on the next analysis frame.
  const nextReference = clampReference(ui.referenceA4.value);
  if (nextReference !== referenceA4) {
    referenceA4 = nextReference;
    engine.setReferenceA4(nextReference);
    if (loopEngine.looping) ui.recordingStatus.textContent = 'Reference A4 changed while a loop plays; the loop keeps the tuning it was recorded in.';
  }
  ui.referenceA4Value.textContent = `${referenceA4.toFixed(1)} Hz`;
  ui.filterValue.textContent = `${ui.filter.value} Hz`;
  ui.delayValue.textContent = `${ui.delay.value}%`;
  ui.reverbValue.textContent = `${ui.reverb.value}%`;
  ui.outputValue.textContent = `${ui.output.value}%`;
  ui.quantizeValue.textContent = `${ui.quantize.value}%`;
  ui.glideValue.textContent = `${ui.glide.value} ms`;
  ui.freeHysteresisValue.textContent = `${ui.freeHysteresis.value} ¢`;
  ui.attackValue.textContent = `${ui.attack.value} ms`;
  ui.releaseValue.textContent = `${ui.release.value} ms`;
  ui.loudnessCurveValue.textContent = Number(ui.loudnessCurve.value).toFixed(2);
  updateScaleUi();
}

// Loop and click levels live on their own buses after the voice gain, so
// the Output slider, the feedback guard and the release never touch them.
function applyLoopLevels() {
  engine.setLoopLevel(Number(ui.loopLevel.value) / 100);
  engine.setClickLevel(Number(ui.clickLevel.value) / 100);
  ui.loopLevelValue.textContent = `${ui.loopLevel.value}%`;
  ui.clickLevelValue.textContent = `${ui.clickLevel.value}%`;
}

function loopNudgeMs() {
  const n = Number(ui.loopNudge.value);
  return Number.isFinite(n) ? Math.max(-250, Math.min(250, Math.round(n))) : 0;
}

// Seconds a sung take lags the grid: the browser's reported latencies plus
// the analysis delay, then the user's nudge. An estimate; see PERFORMANCE.md.
function takeCompensation() {
  return (estimateRoundTripSeconds(browserLatency()) ?? 0) + loopNudgeMs() / 1000;
}

// The textarea is parsed here, on edits, rather than on every analysis frame.
function updateScaleUi() {
  customCentsCache = parseCustomScale(ui.customScaleCents.value);
  const custom = ui.scale.value === 'custom';
  ui.customScaleWrap.hidden = !custom;
  if (custom) {
    const degrees = customCentsCache;
    ui.customScaleStatus.textContent = `${degrees.length} degree${degrees.length === 1 ? '' : 's'} · ${formatCustomScale(degrees)}`;
  }
}

function wireControls() {
  ui.startButton.addEventListener('click', startInstrument);
  ui.calibrationButton.addEventListener('click', calibrateRoom);
  ui.waveform.addEventListener('change', applyBaseControls);
  ui.scale.addEventListener('change', updateScaleUi);
  ui.customScaleCents.addEventListener('input', updateScaleUi);
  for (const control of [ui.filter, ui.delay, ui.reverb, ui.output, ui.quantize, ui.glide, ui.referenceA4, ui.freeHysteresis, ui.attack, ui.release, ui.loudnessCurve]) {
    control.addEventListener('input', applyBaseControls);
  }

  ui.speechToggle.addEventListener('change', toggleSpeech);
  ui.addMapping.addEventListener('click', () => {
    const mappings = readMappings();
    mappings.push({ id: `map-${Date.now()}`, source: 'voice.brightness', destination: 'synth.filterCutoff', amount: 25, curve: 'linear', enabled: true });
    renderMappings(mappings);
  });
  ui.resetMappings.addEventListener('click', () => renderMappings([]));
  ui.mappingRows.addEventListener('input', updateMappingsFromUi);
  ui.mappingRows.addEventListener('change', updateMappingsFromUi);
  ui.mappingRows.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-mapping]');
    if (!button) return;
    button.closest('.mapping-row')?.remove();
    updateMappingsFromUi();
  });

  ui.savePreset.addEventListener('click', saveCurrentPreset);
  ui.loadPreset.addEventListener('click', loadSelectedPreset);
  ui.deletePreset.addEventListener('click', deleteSelectedPreset);
  ui.exportPreset.addEventListener('click', exportSelectedPreset);
  ui.importPreset.addEventListener('click', () => ui.presetFile.click());
  ui.presetFile.addEventListener('change', importPresetFile);
  ui.presetSelect.addEventListener('change', updatePresetButtons);

  ui.midiConnect.addEventListener('click', connectMidi);
  ui.midiInput.addEventListener('change', () => midiManager.setInput(ui.midiInput.value));
  ui.midiOutput.addEventListener('change', () => midiManager.setOutput(ui.midiOutput.value));
  ui.midiInputOverride.addEventListener('change', () => {
    guard.reset();
    tracker.reset();
    if (ui.midiInputOverride.checked) playMidiOverride();
    else engine.release();
  });
  ui.midiOutputToggle.addEventListener('change', () => { if (!ui.midiOutputToggle.checked) midiManager.stopOutput(); });
  ui.midiLearnArm.addEventListener('click', toggleLearn);
  ui.midiLearnClear.addEventListener('click', () => {
    midiBindings = [];
    const persisted = saveBindings(midiBindings);
    renderMidiLearn();
    ui.midiStatus.textContent = persisted ? 'MIDI CC bindings cleared.' : 'MIDI CC bindings cleared for this session; browser storage is blocked.';
  });
  ui.midiLearnList.addEventListener('click', event => {
    const button = event.target.closest('[data-unlearn-cc]');
    if (!button) return;
    const cc = Number(button.dataset.unlearnCc);
    midiBindings = unbindCc(midiBindings, cc);
    saveBindings(midiBindings);
    renderMidiLearn();
    ui.midiStatus.textContent = `CC${cc} binding removed.`;
  });

  ui.recordButton.addEventListener('click', recordTake);
  ui.stopRecord.addEventListener('click', stopRecording);
  ui.downloadRecording.addEventListener('click', downloadRecording);
  ui.transportButton.addEventListener('click', toggleTransport);
  ui.playLoop.addEventListener('click', playLoop);
  ui.stopLoop.addEventListener('click', () => {
    loopEngine.stopLoop();
    ui.recordingStatus.textContent = 'Loop stopped.';
    syncLooperUi();
  });
  ui.metronomeToggle.addEventListener('change', () => loopEngine.setClickEnabled(ui.metronomeToggle.checked));
  ui.loopLevel.addEventListener('input', applyLoopLevels);
  ui.clickLevel.addEventListener('input', applyLoopLevels);
  ui.loopNudge.addEventListener('input', () => { ui.loopNudgeValue.textContent = `${loopNudgeMs()} ms`; });

  ui.loadGhostPlugin.addEventListener('click', () => loadPlugin('./plugins/ghost-radio/manifest.json', ui.loadGhostPlugin));
  ui.loadSandboxPlugin.addEventListener('click', () => loadPlugin('./plugins/sandbox-lfo/manifest.json', ui.loadSandboxPlugin));
  ui.pluginList.addEventListener('input', handlePluginControl);
  ui.pluginList.addEventListener('change', handlePluginControl);
  ui.pluginList.addEventListener('click', event => {
    const button = event.target.closest('[data-unload-plugin]');
    if (!button) return;
    const id = button.dataset.unloadPlugin;
    pluginHost.deactivate(id);
    if (PLUGIN_BUTTONS[id]) resetPluginButton(PLUGIN_BUTTONS[id].button, PLUGIN_BUTTONS[id].label);
    renderPlugins();
  });

  // Suspend audio while the tab is hidden, on both paths. The fallback's
  // requestAnimationFrame stops in hidden tabs, which left the synth droning;
  // the worklet path would otherwise keep playing from a tab nobody sees.
  // engine.suspend() keeps the context running while a take is recording.
  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.hidden) {
      // Before suspend(): the context keeps running while a take records, so
      // the click and the loop would go on in a tab nobody sees. A take that
      // is already recording carries on and auto-stops; a count-in stops.
      const looperBusy = loopEngine.running || loopEngine.looping;
      loopEngine.stopAll({ keepRecording: true });
      if (looperBusy) ui.recordingStatus.textContent = 'Loop stopped because the tab was hidden.';
      syncLooperUi();
      engine.suspend();
      midiManager.stopOutput();
      guard.reset();
      tracker.reset();
    } else {
      guard.reset();
      engine.resume();
    }
  });
  // A note left sounding on external gear would hang after the page closes.
  window.addEventListener('pagehide', () => midiManager.stopOutput());

  new ResizeObserver(sizeScope).observe(ui.scope);
}

function renderMappings(mappings) {
  mappingEngine.setMappings(mappings);
  ui.mappingRows.innerHTML = mappingEngine.getMappings().map(mappingRowHtml).join('') || '<p class="muted empty-state">No modulation mappings. Voice pitch and loudness still control pitch and gain directly.</p>';
}

function mappingRowHtml(mapping) {
  const options = (values, selected) => values.map(value => `<option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('');
  return `<div class="mapping-row" data-id="${escapeHtml(mapping.id)}">
    <label class="mapping-enable"><input type="checkbox" data-field="enabled" ${mapping.enabled ? 'checked' : ''}/> on</label>
    <select data-field="source" aria-label="Mapping source">${options(MAPPING_SOURCES, mapping.source)}</select>
    <span class="mapping-arrow">→</span>
    <select data-field="destination" aria-label="Mapping destination">${options(MAPPING_DESTINATIONS, mapping.destination)}</select>
    <select data-field="curve" aria-label="Mapping curve">${options(['linear', 'square', 'sqrt'], mapping.curve)}</select>
    <label class="mapping-amount"><span>amt</span><input type="number" data-field="amount" min="-100" max="100" value="${escapeHtml(mapping.amount)}"/></label>
    <button class="icon-button" type="button" data-remove-mapping aria-label="Remove mapping">×</button>
  </div>`;
}

function readMappings() {
  return [...ui.mappingRows.querySelectorAll('.mapping-row')].map(row => ({
    id: row.dataset.id,
    enabled: row.querySelector('[data-field="enabled"]').checked,
    source: row.querySelector('[data-field="source"]').value,
    destination: row.querySelector('[data-field="destination"]').value,
    curve: row.querySelector('[data-field="curve"]').value,
    amount: Number(row.querySelector('[data-field="amount"]').value)
  }));
}
function updateMappingsFromUi() { mappingEngine.setMappings(readMappings()); }

function getCurrentState() {
  const tempo = readTempo();
  const state = {
    pitchMode: ui.pitchMode.value,
    scale: ui.scale.value,
    root: ui.root.value,
    customScale: customCentsCache,
    quantize: Number(ui.quantize.value), glide: Number(ui.glide.value), waveform: ui.waveform.value,
    filter: Number(ui.filter.value), delay: Number(ui.delay.value), reverb: Number(ui.reverb.value), output: Number(ui.output.value),
    referenceA4, freeHysteresis: Number(ui.freeHysteresis.value),
    attack: Number(ui.attack.value), release: Number(ui.release.value), loudnessCurve: Number(ui.loudnessCurve.value),
    bpm: tempo.bpm, beatsPerBar: tempo.beatsPerBar, bars: tempo.bars,
    mappings: mappingEngine.getMappings()
  };
  // Bindings describe the user's controller, not the sound, so they travel
  // only when asked.
  if (ui.presetIncludeMidi.checked && midiBindings.length) state.midiLearn = midiBindings;
  return state;
}

// Returns a note for the status line, or ''. Tempo and bindings are
// optional in a preset: a factory preset or the boot load carries neither,
// so it never resets the user's tempo or controller setup.
function applyState(state) {
  if (!state) return '';
  const notes = [];
  const set = (element, value) => { if (value !== undefined && value !== null) element.value = value; };
  set(ui.pitchMode, state.pitchMode); set(ui.scale, state.scale); set(ui.root, state.root);
  if (Array.isArray(state.customScale)) ui.customScaleCents.value = formatCustomScale(state.customScale);
  set(ui.quantize, state.quantize); set(ui.glide, state.glide); set(ui.waveform, state.waveform); set(ui.filter, state.filter);
  set(ui.delay, state.delay); set(ui.reverb, state.reverb); set(ui.output, state.output);
  set(ui.referenceA4, state.referenceA4); set(ui.freeHysteresis, state.freeHysteresis);
  set(ui.attack, state.attack); set(ui.release, state.release); set(ui.loudnessCurve, state.loudnessCurve);
  const tempoKeys = [['bpm', ui.loopBpm], ['beatsPerBar', ui.loopBeats], ['bars', ui.loopBars]].filter(([key]) => state[key] !== undefined);
  if (tempoKeys.length && loopEngine.running) notes.push('Tempo kept; stop the transport to load it.');
  else for (const [key, el] of tempoKeys) set(el, state[key]);
  const bindings = Array.isArray(state.midiLearn) ? sanitizeBindings(state.midiLearn) : [];
  if (bindings.length && ui.presetIncludeMidi.checked) {
    midiBindings = bindings;
    saveBindings(midiBindings);
    renderMidiLearn();
    notes.push(`Loaded ${bindings.length} MIDI binding${bindings.length === 1 ? '' : 's'}.`);
  } else if (bindings.length) {
    notes.push(`This preset carries ${bindings.length} MIDI binding${bindings.length === 1 ? '' : 's'}; check Include MIDI learn bindings to load them.`);
  }
  renderMappings(state.mappings || []);
  tracker.reset();
  applyBaseControls();
  return notes.join(' ');
}

function renderPresets(selectedId = null) {
  const list = presets.list();
  ui.presetSelect.innerHTML = list.map(p => `<option value="${escapeHtml(p.id)}">${p.factory ? '◆ ' : ''}${escapeHtml(p.name)}</option>`).join('');
  if (selectedId && list.some(p => p.id === selectedId)) ui.presetSelect.value = selectedId;
  updatePresetButtons();
}

function saveCurrentPreset() {
  try {
    const state = getCurrentState();
    const id = presets.save(ui.presetName.value || 'Untitled preset', state);
    renderPresets(id);
    ui.presetName.value = '';
    const n = state.midiLearn?.length || 0;
    ui.presetStatus.textContent = `Preset saved in this browser${n ? ` with ${n} MIDI binding${n === 1 ? '' : 's'}` : ''}.`;
  } catch (error) { ui.presetStatus.textContent = error.message; }
}

function loadSelectedPreset() {
  try {
    const state = presets.get(ui.presetSelect.value);
    if (!state) { ui.presetStatus.textContent = 'Preset not found.'; return; }
    const note = applyState(state);
    ui.presetStatus.textContent = note ? `Preset loaded. ${note}` : 'Preset loaded.';
  } catch (error) { ui.presetStatus.textContent = error.message; }
}

function deleteSelectedPreset() {
  try {
    if (presets.remove(ui.presetSelect.value)) {
      renderPresets();
      ui.presetStatus.textContent = 'User preset deleted.';
    }
  } catch (error) { ui.presetStatus.textContent = error.message; }
}

function exportSelectedPreset() {
  try {
    const json = presets.exportPreset(ui.presetSelect.value);
    const record = presets.getRecord(ui.presetSelect.value);
    downloadBlob(new Blob([json], { type: 'application/json' }), `${slug(record?.name || 'voxctl')}.voxctl.json`);
    ui.presetStatus.textContent = 'Preset exported.';
  } catch (error) { ui.presetStatus.textContent = error.message; }
}

async function importPresetFile() {
  const file = ui.presetFile.files?.[0];
  if (!file) return;
  // Checked before file.text(), so a huge or wrong file is never read into memory.
  if (file.size > MAX_PRESET_BYTES) {
    ui.presetStatus.textContent = 'Preset file is too large (256 KB maximum).';
    ui.presetFile.value = '';
    return;
  }
  try {
    const id = presets.importPreset(await file.text());
    renderPresets(id);
    ui.presetStatus.textContent = `Imported ${file.name}.`;
  } catch (error) { ui.presetStatus.textContent = error.message; }
  finally { ui.presetFile.value = ''; }
}

function updatePresetButtons() { ui.deletePreset.disabled = !ui.presetSelect.value.startsWith('user:'); }

async function connectMidi() {
  try {
    const ports = await midiManager.connect();
    renderMidiPorts(ports);
    ui.midiInput.disabled = false;
    ui.midiOutput.disabled = false;
    ui.midiConnect.textContent = 'Refresh MIDI';
    ui.midiStatus.textContent = `${ports.inputs.length} input(s), ${ports.outputs.length} output(s) available.`;
  } catch (error) { ui.midiStatus.textContent = error.message; }
}

// The selects follow the manager, so an unplugged port shows as None
// instead of the UI and the manager disagreeing.
function renderMidiPorts(ports = midiManager.getPorts()) {
  ui.midiInput.innerHTML = `<option value="">None</option>${ports.inputs.map(port => `<option value="${escapeHtml(port.id)}">${escapeHtml(port.name)}</option>`).join('')}`;
  ui.midiOutput.innerHTML = `<option value="">None</option>${ports.outputs.map(port => `<option value="${escapeHtml(port.id)}">${escapeHtml(port.name)}</option>`).join('')}`;
  const { input, output } = midiManager.getSelection();
  ui.midiInput.value = input;
  ui.midiOutput.value = output;
}

function handleMidiEvent(event) {
  if (event.type === 'ports-changed') {
    renderMidiPorts();
    midiState = midiManager.getPerformanceState();
    if (ui.midiInputOverride.checked && !midiState.active) engine.release();
    return;
  }
  // A CC never reaches the override tail below. It used to: with override
  // on and no key held, one CC muted the voice and retriggered MIDI out.
  if (event.type === 'cc') { handleCc(event); return; }
  if (event.state) midiState = event.state;
  if (midiState.active) ui.midiStatus.textContent = `Input: ${displayNote(midiState.midi)} · velocity ${Math.round(midiState.velocity * 127)}`;
  else ui.midiStatus.textContent = 'MIDI connected · no active note.';
  if (!ui.midiInputOverride.checked || calibrating) return;
  // Play keys and bends as they arrive rather than at the next analysis frame.
  if (midiState.active && (event.type === 'note' || event.type === 'bend')) playMidiOverride();
  else if (!midiState.active) { engine.release(); midiManager.stopOutput(); }
}

// Matching is omni: the manager masks the channel. The slider jumps to the
// knob on the first message; there is no pickup.
function handleCc(event) {
  const cc = event.controller;
  const shown = `CC${cc}: ${Math.round(event.value * 127)}`;
  // Channel mode messages (a panic button) never bind, and an armed learn
  // stays armed.
  if (cc > MAX_LEARN_CC) { ui.midiStatus.textContent = shown; return; }
  if (learnArm) {
    const { param } = learnArm;
    clearLearnArm();
    midiBindings = bindCc(midiBindings, cc, param);
    const persisted = saveBindings(midiBindings);
    renderMidiLearn();
    let text = `Learned CC${cc} -> ${learnLabel(param)}.`;
    if (!persisted) text += ' Browser storage is blocked, so it lasts this session only.';
    if (cc === 11 && ui.midiOutputToggle.checked) text += ' VoxCTL sends CC11 on MIDI out; if that output loops back to this input, the slider will follow your voice.';
    ui.midiStatus.textContent = text;
    return;
  }
  const binding = midiBindings.find(b => b.cc === cc);
  if (!binding) { ui.midiStatus.textContent = shown; return; }
  pendingCc.set(binding.param, event.value);
  ccTimer ||= setTimeout(flushCc, 16);
  ui.midiStatus.textContent = `${shown} -> ${learnLabel(binding.param)}`;
}

// At most one update per param every 16 ms. Dispatching 'input' is the path
// a hand drag and the speech commands take, so the same listeners run.
function flushCc() {
  ccTimer = 0;
  for (const [param, value] of pendingCc) {
    const target = learnTarget(param);
    if (!target?.el || target.el.disabled) continue;
    const v = ccToSliderValue(value, { min: Number(target.el.min), max: Number(target.el.max), step: Number(target.el.step) || 1 });
    if (String(v) === String(target.el.value)) continue;
    target.el.value = String(v);
    // Plugin sliders are handled by a delegated listener on #pluginList.
    target.el.dispatchEvent(new Event('input', { bubbles: target.bubbles }));
  }
  pendingCc.clear();
}

function learnTarget(param) {
  if (Object.hasOwn(LEARN, param)) return { ...LEARN[param], bubbles: false };
  const match = PLUGIN_PARAM.exec(String(param));
  if (!match) return null;
  const record = pluginHost.list().find(r => r.manifest.id === match[1]);
  const control = record?.manifest.ui.find(c => c.id === match[2]);
  if (!control) return null;
  return {
    el: ui.pluginList.querySelector(`[data-plugin-id="${cssEscape(match[1])}"][data-plugin-param="${cssEscape(match[2])}"]`),
    label: `${record.manifest.name}: ${control.label}`,
    bubbles: true
  };
}

function learnLabel(param) {
  const target = learnTarget(param);
  if (target) return target.label;
  const match = PLUGIN_PARAM.exec(String(param));
  return match ? `${match[1]} ${match[2]} (plugin not loaded)` : String(param);
}

function renderLearnTargets() {
  const selected = ui.midiLearnTarget.value;
  const fixed = Object.entries(LEARN).map(([param, { label }]) => [param, label]);
  const plugin = pluginHost.list().flatMap(({ manifest }) =>
    manifest.ui.map(control => [`plugin:${manifest.id}:${control.id}`, `${manifest.name}: ${control.label}`]));
  ui.midiLearnTarget.innerHTML = [...fixed, ...plugin].filter(([param]) => isLearnable(param))
    .map(([param, label]) => `<option value="${escapeHtml(param)}">${escapeHtml(label)}</option>`).join('');
  if (selected && [...fixed, ...plugin].some(([param]) => param === selected)) ui.midiLearnTarget.value = selected;
}

function renderMidiLearn() {
  ui.midiLearnList.innerHTML = midiBindings.length
    ? midiBindings.map(b => `<span class="learn-chip">CC${Number(b.cc)} -> ${escapeHtml(learnLabel(b.param))} <button class="icon-button" type="button" data-unlearn-cc="${Number(b.cc)}" aria-label="Remove CC${Number(b.cc)} binding">×</button></span>`).join('')
    : '<span class="muted tiny">No CC bindings.</span>';
}

function toggleLearn() {
  if (learnArm) { clearLearnArm(); ui.midiStatus.textContent = 'MIDI learn canceled.'; return; }
  const param = ui.midiLearnTarget.value;
  if (!isLearnable(param)) { ui.midiStatus.textContent = 'Pick a control to learn.'; return; }
  // A forgotten arm would otherwise bind the next knob anyone touches.
  learnArm = { param, timer: setTimeout(() => { clearLearnArm(); ui.midiStatus.textContent = 'MIDI learn timed out.'; }, 15000) };
  ui.midiLearnArm.textContent = 'Cancel learn';
  const noInput = midiManager.getSelection().input === '';
  ui.midiStatus.textContent = `Move a control on your MIDI device to bind ${learnLabel(param)}.${noInput ? ' Select a MIDI input first.' : ''}`;
}

function clearLearnArm() {
  if (!learnArm) return;
  clearTimeout(learnArm.timer);
  learnArm = null;
  ui.midiLearnArm.textContent = 'Learn CC';
}

// Record, from the button or the speech command. With 'Record to the grid'
// off (the default) this is the 0.3.2 recorder: it starts now and runs until
// Stop.
function recordTake() {
  if (calibrating) { ui.recordingStatus.textContent = CALIBRATING_TEXT; return; }
  // The speech command bypasses the disabled button; a grid take already
  // owns the recorder.
  if (loopEngine.takeState !== 'idle') return;
  if (!ui.syncRecord.checked) { startRecording(); return; }
  try {
    if (!engine.context) throw new Error('Start the instrument first.');
    if (!engine.supportsRecording()) throw new Error('Master-bus recording is not supported by this browser.');
    if (engine.isRecording() || loopEngine.takeState !== 'idle') return;
    const { recordAt } = loopEngine.scheduleTake(readTempo());
    ui.recordingStatus.textContent = `Count-in: the take starts in ${Math.max(0, recordAt - engine.context.currentTime).toFixed(1)} s.`;
  } catch (error) { ui.recordingStatus.textContent = error.message; }
  syncLooperUi();
}

function startRecording() {
  try { beginRecording(); } catch (error) { ui.recordingStatus.textContent = error.message; }
}

function beginRecording() {
  engine.startRecording();
  syncLooperUi();
  ui.recordingStatus.textContent = 'Recording the synth…';
}

// Every stop path lands here: the Stop button, the speech command, a grid
// take's auto-stop, Stop tempo, calibration and a hidden tab. A count-in is
// canceled with no recorder; a take cut short loads as a free take.
async function stopRecording() {
  loopEngine.cancelTake({ stopRecorder: false });
  const grid = loopEngine.consumeGrid();
  const startedAt = engine.startCallTime;
  try {
    const blob = await engine.stopRecording();
    if (!blob) return;
    const elapsed = engine.context && Number.isFinite(startedAt) ? engine.context.currentTime - startedAt : 0;
    recordingBlob = blob;
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    recordingUrl = URL.createObjectURL(blob);
    ui.recordingPlayer.src = recordingUrl;
    fixUnknownDuration(ui.recordingPlayer);
    ui.downloadRecording.disabled = false;
    const ready = `Take ready · ${(blob.size / 1024).toFixed(1)} KiB · ${blob.type || 'browser audio'}`;
    ui.recordingStatus.textContent = `${ready}. Decoding for the looper…`;
    // A decode failure keeps the take downloadable and the previous loop.
    try {
      const { mode } = await loopEngine.loadTake(blob, { grid, elapsed });
      ui.recordingStatus.textContent = `${ready}. ${mode === 'grid' ? 'On the grid; ready to loop.' : 'Ready to loop, fitted to the bars.'}`;
    } catch (error) {
      ui.recordingStatus.textContent = `${ready}. ${error.message}`;
    }
  } catch (error) { ui.recordingStatus.textContent = error.message; }
  finally { syncLooperUi(); }
}

// The tempo inputs, clamped and written back, or the running tempo.
function readTempo() {
  if (loopEngine.running) return { ...loopEngine.tempo };
  const tempo = clampTempo({ bpm: ui.loopBpm.value, beatsPerBar: ui.loopBeats.value, bars: ui.loopBars.value });
  ui.loopBpm.value = String(tempo.bpm);
  ui.loopBeats.value = String(tempo.beatsPerBar);
  ui.loopBars.value = String(tempo.bars);
  return tempo;
}

function toggleTransport() {
  if (loopEngine.running) {
    loopEngine.stopAll();
    ui.recordingStatus.textContent = 'Tempo stopped.';
  } else if (calibrating) {
    ui.recordingStatus.textContent = CALIBRATING_TEXT;
  } else {
    try {
      const { tempo } = loopEngine.startTransport(readTempo());
      ui.recordingStatus.textContent = `Tempo ${tempo.bpm} BPM, ${tempo.beatsPerBar} beats per bar.`;
    } catch (error) { ui.recordingStatus.textContent = error.message; }
  }
  syncLooperUi();
}

function playLoop() {
  if (calibrating) { ui.recordingStatus.textContent = CALIBRATING_TEXT; return; }
  try {
    const r = loopEngine.playLoop(readTempo());
    const speed = r.rate === 1 ? '' : ` It plays at ${r.rate.toFixed(2)}x, ${r.cents >= 0 ? '+' : ''}${r.cents} cents (speed and pitch change together).`;
    ui.recordingStatus.textContent = `${r.waitMs >= 20 ? `Loop starts on the next bar, in ${Math.round(r.waitMs)} ms.` : 'Loop playing.'}${speed}`;
  } catch (error) { ui.recordingStatus.textContent = error.message; }
  syncLooperUi();
}

function syncLooperUi() {
  const transport = loopEngine.running;
  ui.transportButton.textContent = transport ? 'Stop tempo' : 'Start tempo';
  for (const input of [ui.loopBpm, ui.loopBeats, ui.loopBars]) input.disabled = transport;
  ui.playLoop.disabled = !loopEngine.hasTake;
  ui.stopLoop.disabled = !loopEngine.looping;
  const busy = loopEngine.takeState !== 'idle' || engine.isRecording();
  ui.recordButton.disabled = busy || !running || !engine.supportsRecording();
  ui.stopRecord.disabled = !busy;
}

// Chrome's MediaRecorder writes WebM with no duration, so the player reports
// Infinity and cannot show length or seek. Seeking far past the end makes the
// browser scan the file and settle the real duration; then rewind.
function fixUnknownDuration(player) {
  player.addEventListener('loadedmetadata', () => {
    if (player.duration !== Infinity) return;
    player.addEventListener('durationchange', () => { player.currentTime = 0; }, { once: true });
    player.currentTime = 1e101;
  }, { once: true });
}

function downloadRecording() {
  if (!recordingBlob) return;
  downloadBlob(recordingBlob, `voxctl-${new Date().toISOString().replace(/[:.]/g, '-')}.${recordingExtension(recordingBlob.type)}`);
}

async function loadPlugin(url, button) {
  // Disabled before the await so a double click cannot start two loads.
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const record = await pluginHost.loadManifest(url);
    renderPlugins();
    button.textContent = `${record.manifest.name} loaded`;
    ui.pluginStatus.textContent = '';
  } catch (error) {
    console.error(error);
    button.disabled = false;
    button.textContent = 'Load failed, retry';
    ui.pluginStatus.textContent = error.message;
  }
}

function resetPluginButton(button, text) { button.disabled = false; button.textContent = text; }

function renderPlugins() {
  const plugins = pluginHost.list();
  ui.pluginList.innerHTML = plugins.length ? plugins.map(pluginCardHtml).join('') : '<p class="muted">No optional plugins loaded.</p>';
  // Plugin controls come and go with their plugin, and so do their labels.
  renderLearnTargets();
  renderMidiLearn();
}

function pluginCardHtml({ manifest, mode }) {
  const controls = manifest.ui.map(control => pluginControlHtml(manifest.id, control)).join('');
  return `<div class="plugin-card plugin-card-rich">
    <div class="plugin-card-head"><div><strong>${escapeHtml(manifest.name)}</strong><small>${escapeHtml(manifest.type)} · v${escapeHtml(manifest.version)}</small><small>${escapeHtml(manifest.description)}</small></div><span class="capability-badge">${mode === 'isolated' ? 'isolated' : 'trusted'}</span></div>
    ${controls ? `<div class="plugin-controls">${controls}</div>` : ''}
    <div class="plugin-footer"><small>${manifest.permissions.map(escapeHtml).join(', ') || 'no capabilities'}</small><button class="icon-button unload-button" type="button" data-unload-plugin="${escapeHtml(manifest.id)}">Unload</button></div>
  </div>`;
}

// The host has already validated every control as a range with numeric bounds.
function pluginControlHtml(pluginId, control) {
  return `<label class="plugin-control">${escapeHtml(control.label)} <output data-plugin-output="${escapeHtml(pluginId)}:${escapeHtml(control.id)}">${escapeHtml(control.default)}</output><input type="range" data-plugin-id="${escapeHtml(pluginId)}" data-plugin-param="${escapeHtml(control.id)}" min="${Number(control.min)}" max="${Number(control.max)}" step="${Number(control.step || 1)}" value="${Number(control.default)}" /></label>`;
}

function handlePluginControl(event) {
  const input = event.target.closest('[data-plugin-id][data-plugin-param]');
  if (!input) return;
  pluginHost.setParameter(input.dataset.pluginId, input.dataset.pluginParam, Number(input.value));
  const output = ui.pluginList.querySelector(`[data-plugin-output="${cssEscape(`${input.dataset.pluginId}:${input.dataset.pluginParam}`)}"]`);
  if (output) output.textContent = input.value;
}

// Errors that will recur on every restart. Restarting after one of these
// loops as fast as the browser can fire onend.
const FATAL_SPEECH_ERRORS = new Set([
  'not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported'
]);

function stopSpeech() {
  const rec = recognition;
  recognition = null;
  if (!rec) return;
  rec.onresult = rec.onerror = rec.onend = null;
  try { rec.abort(); } catch (error) { console.warn(error); }
}

function toggleSpeech() {
  // Always drop the old recognizer first, so a quick off/on cannot leave two running.
  stopSpeech();
  if (!ui.speechToggle.checked) { ui.speechStatus.textContent = 'Spoken commands disabled.'; return; }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { ui.speechToggle.checked = false; ui.speechStatus.textContent = 'Speech recognition is not supported by this browser.'; return; }

  const rec = new SpeechRecognition();
  rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
  rec.onresult = event => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (!event.results[i].isFinal) continue;
      const text = event.results[i][0].transcript.trim().toLowerCase();
      ui.speechStatus.textContent = `Heard: "${text}"`;
      handleCommand(text);
    }
  };
  rec.onerror = e => {
    if (FATAL_SPEECH_ERRORS.has(e.error)) {
      recognition = null;
      ui.speechToggle.checked = false;
      ui.speechStatus.textContent = `Spoken commands stopped: ${e.error}`;
    } else {
      ui.speechStatus.textContent = `Speech error: ${e.error}`;
    }
  };
  // Continuous recognition still ends on silence; restart unless this
  // recognizer has been replaced or stopped.
  rec.onend = () => {
    setTimeout(() => {
      if (recognition !== rec) return;
      try { rec.start(); } catch (error) {
        recognition = null;
        ui.speechToggle.checked = false;
        ui.speechStatus.textContent = `Spoken commands stopped: ${error.message}`;
      }
    }, 500);
  };
  recognition = rec;
  rec.start();
  ui.speechStatus.textContent = 'Listening for commands…';
}

function handleCommand(text) {
  if (text.includes('wave sine')) setSelect(ui.waveform, 'sine');
  else if (text.includes('wave saw')) setSelect(ui.waveform, 'sawtooth');
  else if (text.includes('wave square')) setSelect(ui.waveform, 'square');
  else if (text.includes('wave triangle')) setSelect(ui.waveform, 'triangle');
  else if (text.includes('free mode')) setSelect(ui.pitchMode, 'free');
  else if (text.includes('quantize')) setSelect(ui.pitchMode, 'quantized');
  else if (text.includes('more reverb')) bump(ui.reverb, 10);
  else if (text.includes('less reverb')) bump(ui.reverb, -10);
  else if (text.includes('more delay')) bump(ui.delay, 10);
  else if (text.includes('less delay')) bump(ui.delay, -10);
  else if (text.includes('calibrate')) calibrateRoom();
  else if (text.includes('stop recording')) stopRecording();
  else if (text.includes('record')) recordTake();
}

function setSelect(select, value) { select.value = value; select.dispatchEvent(new Event('change')); applyBaseControls(); }
function bump(range, delta) { range.value = Math.max(Number(range.min), Math.min(Number(range.max), Number(range.value) + delta)); range.dispatchEvent(new Event('input')); }
function displayNote(midi) {
  if (!Number.isFinite(midi)) return '--';
  const rounded = Math.round(midi);
  const cents = Math.round((midi - rounded) * 100);
  return `${midiToNote(rounded)}${Math.abs(cents) >= 2 ? `${cents >= 0 ? '+' : ''}${cents}¢` : ''}`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'preset'; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function cssEscape(value) { return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }

const savedCalibration = calibration.load();
if (savedCalibration) noiseGate = savedCalibration.noiseGate;
renderCalibration(savedCalibration);
runCompatibilityCheck();
wireControls();
sizeScope();
renderPresets('factory:classic');
// Boot into the preset the selector shows, so the matrix and the sound match it.
applyState(presets.get('factory:classic'));
renderPlugins();
loopEngine.setClickEnabled(ui.metronomeToggle.checked);
applyLoopLevels();
syncLooperUi();
renderLatency();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js')
    .then(() => setCapability('sw', true, 'offline cache registered'))
    .catch(error => { console.warn(error); setCapability('sw', false, 'registration failed'); }));
}
