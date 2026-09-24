import { windowSizeFor } from './pitch-detector.js';

// Analysis rate, shared by both paths so glide and the feedback guard behave
// the same whichever one runs.
export const ANALYSIS_MS = 30;

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
    this.recordDestination = null;
    this.recorder = null;
    this.starting = null;
    this.onRecordingError = null;
    this.base = { filter: 4200, delay: 0.18, reverb: 0.28, master: 0.65 };
    this.mapping = { filter: 0, delay: 0, reverb: 0, master: 0, detune: 0 };
    this.plugin = { filter: 0, delay: 0, reverb: 0, master: 0, detune: 0 };
    this.detuneCents = 0;
    this.waveform = 'sine';
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
    this.recordDestination = typeof c.createMediaStreamDestination === 'function' ? c.createMediaStreamDestination() : null;

    this.oscillator.type = this.waveform;
    // Pitch lives in detune (cents from A4) so glides move evenly in
    // semitones. Mapping and plugin detune ride on a separate constant source
    // wired into the same param: AudioParam inputs sum with its own value, so
    // the two never cancel each other's scheduled ramps.
    this.oscillator.frequency.value = 440;
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
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.15;

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
    // reach about +5 dBFS. The recorder taps after the limiter so a take
    // matches what was heard.
    this.master.connect(this.limiter);
    this.limiter.connect(c.destination);
    if (this.recordDestination) this.limiter.connect(this.recordDestination);
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

  setVoiceLevel(rms, outputScalar = 1, noiseGate = 0.008) {
    if (!this.context) return;
    const normalized = Math.max(0, Math.min(1, (rms - noiseGate) / Math.max(0.05, 0.13 - noiseGate)));
    const shaped = Math.pow(normalized, 0.72) * outputScalar;
    this.voiceGain.gain.setTargetAtTime(shaped, this.context.currentTime, 0.018);
  }

  setVoiceLevelNormalized(value) {
    if (!this.context) return;
    const shaped = clamp(value, 0, 1);
    this.voiceGain.gain.setTargetAtTime(shaped, this.context.currentTime, 0.018);
  }

  silence() {
    if (this.context) this.voiceGain.gain.setTargetAtTime(0, this.context.currentTime, 0.035);
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
