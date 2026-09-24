import { windowSizeFor } from './pitch-detector.js';
import { clickSamples } from './loop-engine.js';
import { A4_DEFAULT, clampReference } from '../mapping/scales.js';

// Analysis rate, shared by both paths so glide and the feedback guard behave
// the same whichever one runs.
export const ANALYSIS_MS = 30;

// Time constant of the safety mute. The feedback guard probes for 300 ms, and
// 0.3 / 0.035 > ln(100), so the synth is under 1% inside the probe. Nothing
// the user sets may slow this down: with the release time as the mute, a
// speaker loop through Bluetooth output went uncaught from 300 ms up.
export const MUTE_TAU_S = 0.035;

// Times are to about 95 percent (tau = ms / 3), the same convention as glide.
// v0.3.2 used an 18 ms constant for level changes, 35 ms at note end and the
// same 0.72 curve; 54 and 105 ms reproduce those constants.
export const DYNAMICS_DEFAULTS = Object.freeze({ attackMs: 54, releaseMs: 105, curve: 0.72 });
// The one source of these ranges for sliders, presets and MIDI learn.
export const DYNAMICS_LIMITS = Object.freeze({ attackMs: Object.freeze([1, 500]), releaseMs: Object.freeze([5, 2000]), curve: Object.freeze([0.25, 2.5]) });

// Shared by the heard limiter and its twin on the record path, so a take
// with no loop playing matches what was heard.
const LIMITER = { threshold: -6, knee: 6, ratio: 12, attack: 0.003, release: 0.15 };

export class AudioEngine {
  constructor() {
    this.context = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.analysisWorklet = null;
    this.silentWorkletSink = null;
    this.oscillator = null;
    this.detuneMod = null;
    this.voiceGain = null;
    this.filter = null;
    this.delay = null;
    this.delayFeedback = null;
    this.delayWet = null;
    this.reverb = null;
    this.reverbWet = null;
    this.dryGain = null;
    this.master = null;
    this.limiter = null;
    this.recLimiter = null;
    this.loopBus = null;
    this.clickBus = null;
    this.recordDestination = null;
    this.recorder = null;
    this.startCallTime = null;
    this.starting = null;
    this.onRecordingError = null;
    this.base = { filter: 4200, delay: 0.18, reverb: 0.28, master: 0.65 };
    this.mapping = { filter: 0, delay: 0, reverb: 0, master: 0, detune: 0 };
    this.plugin = { filter: 0, delay: 0, reverb: 0, master: 0, detune: 0 };
    this.detuneCents = 0;
    this.waveform = 'sine';
    this.referenceA4 = A4_DEFAULT;
    this.dynamics = { ...DYNAMICS_DEFAULTS };
    // Model of the voice gain's setTargetAtTime curve, so attack or release
    // is chosen against where the gain is now rather than the last target.
    this.level = { from: 0, to: 0, t0: 0, tau: MUTE_TAU_S };
    this.muting = true;
  }

  get windowSize() { return windowSizeFor(this.context.sampleRate); }

  // A second call while the first is still waiting on the mic prompt shares
  // its promise. Two concurrent calls used to open two streams and leak one.
  start() {
    this.starting ??= this.startOnce().finally(() => { this.starting = null; });
    return this.starting;
  }

  async startOnce() {
    if (!this.context) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextCtor({ latencyHint: 'interactive' });
      this.buildSynthGraph();
    }
    if (this.context.state === 'suspended') await this.context.resume();

    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      });
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      // 4096 keeps the spectrum fine enough for formant estimates; the pitch
      // detector reads only the most recent windowSize samples of it.
      this.analyser.fftSize = Math.max(4096, this.windowSize);
      this.analyser.smoothingTimeConstant = 0.16;
      this.source.connect(this.analyser);
    }
    return this.context;
  }

  // onWindow receives a Float32Array of windowSize samples, oldest first,
  // every ANALYSIS_MS. Run it through the shared PitchDetector.
  async enableAnalysisWorklet(onWindow) {
    if (!this.context?.audioWorklet || !window.AudioWorkletNode || !this.source) return false;
    try {
      await this.context.audioWorklet.addModule('./src/audio/worklets/analysis-worklet.js');
      const hopSize = Math.max(128, Math.round((this.context.sampleRate * ANALYSIS_MS) / 1000 / 128) * 128);
      this.analysisWorklet = new AudioWorkletNode(this.context, 'voice-analyzer-processor', {
        processorOptions: { windowSize: this.windowSize, hopSize }
      });
      this.silentWorkletSink = this.context.createGain();
      this.silentWorkletSink.gain.value = 0;
      this.source.connect(this.analysisWorklet);
      this.analysisWorklet.connect(this.silentWorkletSink);
      this.silentWorkletSink.connect(this.context.destination);
      this.analysisWorklet.port.onmessage = event => {
        if (event.data?.type === 'window') onWindow?.(event.data.samples);
      };
      return true;
    } catch (error) {
      console.warn('AudioWorklet unavailable; falling back to main-thread pitch detection.', error);
      return false;
    }
  }

  buildSynthGraph() {
    const c = this.context;
    this.oscillator = c.createOscillator();
    this.detuneMod = c.createConstantSource();
    this.voiceGain = c.createGain();
    this.filter = c.createBiquadFilter();
    this.dryGain = c.createGain();
    this.delay = c.createDelay(2);
    this.delayFeedback = c.createGain();
    this.delayWet = c.createGain();
    this.reverb = c.createConvolver();
    this.reverbWet = c.createGain();
    this.master = c.createGain();
    this.limiter = c.createDynamicsCompressor();
    this.recLimiter = c.createDynamicsCompressor();
    this.loopBus = c.createGain();
    this.clickBus = c.createGain();
    this.recordDestination = typeof c.createMediaStreamDestination === 'function' ? c.createMediaStreamDestination() : null;

    this.oscillator.type = this.waveform;
    // Pitch lives in detune as cents from the A4 reference, so glides move
    // evenly in semitones and a reference change only moves this base.
    // Mapping and plugin detune ride on a separate constant source wired into
    // the same param: AudioParam inputs sum with its own value, so the two
    // never cancel each other's scheduled ramps.
    this.oscillator.frequency.value = this.referenceA4;
    this.oscillator.detune.value = -1200;
    this.detuneMod.offset.value = 0;
    this.voiceGain.gain.value = 0;
    this.filter.type = 'lowpass';
    this.filter.frequency.value = this.base.filter;
    this.filter.Q.value = 1.2;
    this.delay.delayTime.value = 0.28;
    this.delayFeedback.gain.value = 0.24;
    this.delayWet.gain.value = this.base.delay;
    this.reverb.buffer = this.createImpulse(2.6, 2.3);
    this.reverbWet.gain.value = this.base.reverb;
    this.dryGain.gain.value = 0.78;
    this.master.gain.value = this.base.master;
    for (const comp of [this.limiter, this.recLimiter]) {
      for (const [key, value] of Object.entries(LIMITER)) comp[key].value = value;
    }
    this.loopBus.gain.value = 0.8;
    this.clickBus.gain.value = 0.5;

    this.detuneMod.connect(this.oscillator.detune);
    this.oscillator.connect(this.voiceGain);
    this.voiceGain.connect(this.filter);
    this.filter.connect(this.dryGain);
    this.dryGain.connect(this.master);
    this.filter.connect(this.delay);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);
    this.delay.connect(this.delayWet);
    this.delayWet.connect(this.master);
    this.filter.connect(this.reverb);
    this.reverb.connect(this.reverbWet);
    this.reverbWet.connect(this.master);
    // Dry, delay and reverb at their ceilings with mapped master gain can
    // reach about +5 dBFS. Loop playback and the click join the heard limiter
    // next to master, so the heard path keeps one compressor (each adds about
    // 6 ms) and the Output slider, mappings and plugin ducking never touch
    // them. The recorder taps a twin limiter on master alone, so a take
    // matches the heard synth without the loop or the click. A loud loop or
    // click can briefly compress the heard synth; the take is not affected.
    this.master.connect(this.limiter);
    this.master.connect(this.recLimiter);
    this.loopBus.connect(this.limiter);
    this.clickBus.connect(this.limiter);
    this.limiter.connect(c.destination);
    if (this.recordDestination) this.recLimiter.connect(this.recordDestination);
    this.oscillator.start();
    this.detuneMod.start();
  }

  createImpulse(seconds, decay) {
    const rate = this.context.sampleRate;
    const length = Math.floor(rate * seconds);
    const impulse = this.context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
    return impulse;
  }

  // The only pitch smoothing in the app. setTargetAtTime runs on the audio
  // clock, so the glide is the same length on either analysis path. jump
  // lands on the note at once, for the first frame after silence.
  setPitch(midi, glideMs = 45, { jump = false } = {}) {
    if (!this.context || !Number.isFinite(midi)) return;
    const now = this.context.currentTime;
    const cents = (midi - 69) * 100;
    this.oscillator.detune.cancelScheduledValues(now);
    if (jump) this.oscillator.detune.setValueAtTime(cents, now);
    else this.oscillator.detune.setTargetAtTime(cents, now, Math.max(0.001, glideMs / 1000) / 3);
  }

  // Moves the base the pitch detune works from. It steps at once; in free
  // mode the voice-following detune catches up on the next analysis frame.
  setReferenceA4(hz) {
    this.referenceA4 = clampReference(hz);
    if (this.context) this.oscillator.frequency.setValueAtTime(this.referenceA4, this.context.currentTime);
  }

  // A non-finite field is left as it is.
  setDynamics({ attackMs, releaseMs, curve } = {}) {
    const put = (key, value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const [min, max] = DYNAMICS_LIMITS[key];
      this.dynamics[key] = Math.max(min, Math.min(max, value));
    };
    put('attackMs', attackMs);
    put('releaseMs', releaseMs);
    put('curve', curve);
  }

  // Where setTargetAtTime has taken the voice gain by time t.
  levelAt(t) {
    const { from, to, t0, tau } = this.level;
    return to + (from - to) * Math.exp(-Math.max(0, t - t0) / tau);
  }

  rampLevel(target, tau) {
    const now = this.context.currentTime;
    const from = this.levelAt(now);
    this.voiceGain.gain.setTargetAtTime(target, now, tau);
    this.level = { from, to: target, t0: now, tau };
    this.muting = false;
  }

  // The loudness curve shapes the synth voice only; MIDI out stays linear.
  setVoiceLevel(rms, outputScalar = 1, noiseGate = 0.008) {
    if (!this.context) return;
    const normalized = Math.max(0, Math.min(1, (rms - noiseGate) / Math.max(0.05, 0.13 - noiseGate)));
    this.setVoiceLevelNormalized(Math.pow(normalized, this.dynamics.curve) * outputScalar);
  }

  // Attack for a rise and release for a fall, judged against the modeled
  // gain. So release also slows a voice getting quieter, not only note end.
  setVoiceLevelNormalized(value) {
    if (!this.context) return;
    const target = clamp(value, 0, 1);
    const rising = target > this.levelAt(this.context.currentTime);
    const ms = rising ? this.dynamics.attackMs : this.dynamics.releaseMs;
    this.rampLevel(target, Math.max(0.001, ms / 3000));
  }

  // Musical note end: follows the release setting. While a mute is in force
  // the gain is already falling faster, and a release would only slow it.
  release() { if (!this.muting) this.setVoiceLevelNormalized(0); }

  // The safety path, for the feedback guard, calibration, a hidden tab and a
  // stalled worklet. It never reads the dynamics. A later setTargetAtTime
  // supersedes a running long release (checked in Chromium), so no cancel is
  // needed. The guard and a stalled worklet call this every frame, so a mute
  // already in force schedules nothing.
  mute() {
    if (!this.context || this.muting) return;
    const now = this.context.currentTime;
    const from = this.levelAt(now);
    this.voiceGain.gain.setTargetAtTime(0, now, MUTE_TAU_S);
    this.level = { from, to: 0, t0: now, tau: MUTE_TAU_S };
    this.muting = true;
  }

  setLoopLevel(value) { this.setBusLevel(this.loopBus, value); }
  setClickLevel(value) { this.setBusLevel(this.clickBus, value); }

  setBusLevel(bus, value) {
    if (!this.context || !bus) return;
    bus.gain.setTargetAtTime(clamp(value, 0, 1), this.context.currentTime, 0.025);
  }

  async decodeTake(blob) {
    if (!this.context) throw new Error('Start the instrument first.');
    return this.context.decodeAudioData(await blob.arrayBuffer());
  }

  // A mono copy of channel 0 (the synth is mono), exactly frames long from
  // start, zero padded past the end of the take.
  makeLoopBuffer(decoded, { start = 0, frames }) {
    const c = this.context;
    const length = Math.max(1, Math.round(frames));
    const out = c.createBuffer(1, length, c.sampleRate);
    const src = decoded.getChannelData(0);
    const from = Math.max(0, Math.round(start));
    const n = Math.max(0, Math.min(length, src.length - from));
    if (n > 0) out.getChannelData(0).set(src.subarray(from, from + n));
    return out;
  }

  createClickBuffer(hz) {
    const c = this.context;
    const samples = clickSamples(c.sampleRate, hz);
    const buffer = c.createBuffer(1, samples.length, c.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  // Hidden tabs stop requestAnimationFrame, so the fallback path froze the
  // voice gain and droned. Suspending the context also silences the record
  // bus, so while a take is recording the voice is only zeroed and the
  // context keeps running; the take then records silence, not a gap.
  // Resolves true if the context was suspended.
  async suspend() {
    if (this.context?.state !== 'running') return false;
    const now = this.context.currentTime;
    this.voiceGain.gain.cancelScheduledValues(now);
    this.voiceGain.gain.setValueAtTime(0, now);
    this.level = { from: 0, to: 0, t0: now, tau: MUTE_TAU_S };
    this.muting = true;
    if (this.isRecording()) return false;
    await this.context.suspend();
    return true;
  }

  resume() { return this.context?.state === 'suspended' ? this.context.resume() : Promise.resolve(); }

  supportsRecording() {
    return Boolean(this.recordDestination && window.MediaRecorder);
  }

  isRecording() { return this.recorder?.state === 'recording'; }

  startRecording() {
    if (!this.context) throw new Error('Start the instrument first.');
    if (!this.supportsRecording()) throw new Error('Master-bus recording is not supported by this browser.');
    if (this.isRecording()) return;
    const mimeType = pickRecordingMimeType();
    const recorder = mimeType
      ? new MediaRecorder(this.recordDestination.stream, { mimeType })
      : new MediaRecorder(this.recordDestination.stream);
    // Chunks live with their recorder. A shared array let a pending stop
    // build its blob from the next take's chunks.
    recorder.chunks = [];
    recorder.ondataavailable = event => { if (event.data?.size) recorder.chunks.push(event.data); };
    recorder.onerror = event => {
      if (this.recorder === recorder) this.recorder = null;
      this.onRecordingError?.(event.error || new Error('Recorder failed.'));
    };
    this.recorder = recorder;
    // Read just before start(): measured in Chrome, a take offset from this
    // call time was 6.5 to 14.5 ms off, and one read in onstart 68 to 76 ms.
    this.startCallTime = this.context.currentTime;
    recorder.start(250);
  }

  stopRecording() {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      recorder.onerror = event => reject(event.error || new Error('Recorder failed.'));
      recorder.onstop = () => {
        const type = recorder.mimeType || recorder.chunks[0]?.type || 'audio/webm';
        resolve(new Blob(recorder.chunks, { type }));
      };
      recorder.stop();
    });
  }

  setWaveform(type) { this.waveform = type; if (this.oscillator) this.oscillator.type = type; }
  setFilter(hz) { this.base.filter = Number(hz); this.applyModulation(); }
  setDelayMix(value) { this.base.delay = Number(value); this.applyModulation(); }
  setReverbMix(value) { this.base.reverb = Number(value); this.applyModulation(); }
  setMaster(value) { this.base.master = Number(value); this.applyModulation(); }

  setMappingModulations(values = {}) {
    this.mapping.filter = Number(values.filter) || 0;
    this.mapping.delay = Number(values.delay) || 0;
    this.mapping.reverb = Number(values.reverb) || 0;
    this.mapping.master = Number(values.master) || 0;
    this.mapping.detune = Number(values.detune) || 0;
    this.applyModulation();
  }

  setPluginFilterOffset(value) { this.plugin.filter = Number(value) || 0; this.applyModulation(); }
  setPluginDetuneOffset(value) { this.plugin.detune = Number(value) || 0; this.applyModulation(); }
  setPluginDelayOffset(value) { this.plugin.delay = Number(value) || 0; this.applyModulation(); }
  setPluginReverbOffset(value) { this.plugin.reverb = Number(value) || 0; this.applyModulation(); }
  // A plugin may duck the output but never raise it past the user's slider.
  setPluginMasterOffset(value) { this.plugin.master = clamp(value, -1, 0); this.applyModulation(); }

  // Mapping and plugin detune in cents, applied after quantizing. The app
  // adds it to the note readout and MIDI out so all three agree.
  getModulationCents() { return this.detuneCents; }

  applyModulation() {
    const filterHz = clamp(this.base.filter + this.mapping.filter * 6000 + this.plugin.filter, 120, 14000);
    const delay = clamp(this.base.delay + this.mapping.delay * 0.6 + this.plugin.delay, 0, 0.85);
    const reverb = clamp(this.base.reverb + this.mapping.reverb * 0.7 + this.plugin.reverb, 0, 0.9);
    const master = clamp(this.base.master + this.mapping.master * 0.45 + this.plugin.master, 0, 1);
    this.detuneCents = clamp(this.mapping.detune * 1200 + this.plugin.detune, -2400, 2400);
    if (!this.context) return;
    // Cancel first: plugins can post many offsets per frame, and each call
    // otherwise stacked more automation events on every param.
    const now = this.context.currentTime;
    const set = (param, value) => { param.cancelScheduledValues(now); param.setTargetAtTime(value, now, 0.025); };
    set(this.filter.frequency, filterHz);
    set(this.delayWet.gain, delay);
    set(this.reverbWet.gain, reverb);
    set(this.master.gain, master);
    set(this.detuneMod.offset, this.detuneCents);
  }
}

function pickRecordingMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) return '';
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
    .find(type => MediaRecorder.isTypeSupported(type)) || '';
}

// File extension for a recorded blob's MIME type. Safari records audio/mp4,
// which was saved as .webm and would not open.
export function recordingExtension(type = '') {
  if (type.includes('mp4') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
