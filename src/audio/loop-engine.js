// Tempo looper: a transport with a metronome click, a one-bar count-in for
// takes recorded to the grid, and loop playback of the last take.
//
// Routing is the engine's: loop sources connect only to engine.loopBus and
// clicks only to engine.clickBus. Both join the heard limiter after
// voiceGain, so the feedback guard's mute and the release setting never
// touch them, and neither reaches the recorder. Takes are the synth only.
//
// All timing runs on the audio clock through a lookahead scheduler. The
// interval only decides when to look; every click and loop start is placed
// with start(time).

export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const MAX_BEATS = 12;
export const MAX_BARS = 16;
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const START_LEAD = 0.1;
export const MIN_LEAD = 0.05;
export const PREROLL = 0.15;
export const LOOKAHEAD = 0.12;
export const TICK_MS = 25;
export const PAD_TOLERANCE = 0.06;
export const MAX_DECODE_S = 600;

// Both pitches sit above the pitch detector's 1400 Hz ceiling, so a click
// leaking into the mic reads unvoiced while the singer is silent.
export const ACCENT_HZ = 2400;
export const BEAT_HZ = 1800;
const CLICK_S = 0.02;
const CLICK_ATTACK_S = 0.001;
const CLICK_TAU_S = 0.005;
const CLICK_PEAK = 0.5;

const TEMPO_FALLBACK = { bpm: 96, beatsPerBar: 4, bars: 1 };

export function barSeconds(bpm, beatsPerBar) { return 60 / bpm * beatsPerBar; }

// The first bar line at or after t. A small tolerance keeps t sitting on a
// bar line from being pushed to the next one by float error.
export function barAtOrAfter(origin, t, bar) {
  return origin + Math.max(0, Math.ceil((t - origin - 1e-6) / bar)) * bar;
}

// Beats with from <= time < to. beat 0 is the accent.
export function beatsInWindow(origin, from, to, bpm, beatsPerBar) {
  const len = 60 / bpm;
  const out = [];
  for (let k = Math.max(0, Math.ceil((from - origin) / len - 1e-9)); ; k++) {
    const time = origin + k * len;
    if (time >= to) break;
    if (time >= from) out.push({ time, beat: k % beatsPerBar, bar: Math.floor(k / beatsPerBar) });
  }
  return out;
}

// Longest recorded wall-clock length worth decoding. Anything longer could
// never fit MAX_BARS at 0.5x, and a 30 min take decodes to about 691 MB.
export function maxDecodeSeconds(barSec) {
  return Math.min(MAX_DECODE_S, 2 * MAX_BARS * barSec + 1);
}

// How a take of available seconds becomes a loop of target seconds.
// gridLength is the length a grid take was recorded to; it is fitted instead
// of the take's own length, which includes the post-roll. A rate outside
// 0.5x to 2x is refused rather than clamped, because a clamped rate drifts
// against the grid every cycle.
export function fitLoop({ available, target, gridLength = null, barSec = target, bpm = null, beatsPerBar = null }) {
  if (gridLength !== null && gridLength !== undefined) {
    if (Math.abs(gridLength - target) <= 0.001) return { mode: 'trim', rate: 1, cents: 0 };
    return rated(gridLength, target, barSec, bpm, beatsPerBar);
  }
  if (!(available > 0.05)) throw new RangeError('Take ended before the first bar.');
  return rated(available, target, barSec, bpm, beatsPerBar);
}

function rated(length, target, barSec, bpm, beatsPerBar) {
  const rate = length / target;
  if (rate >= MIN_RATE && rate <= MAX_RATE) return { mode: 'rate', rate, cents: Math.round(1200 * Math.log2(rate)) };
  const where = bpm ? `At ${bpm} BPM ${beatsPerBar}/4 it` : 'It';
  const bars = Math.max(1, Math.min(MAX_BARS, Math.round(length / barSec)));
  const fits = length / (bars * barSec);
  if (fits >= MIN_RATE && fits <= MAX_RATE) {
    throw new RangeError(`This take is ${length.toFixed(1)} s. ${where} fits ${bars} bar${bars === 1 ? '' : 's'}; set Bars to ${bars}.`);
  }
  throw new RangeError(`This take is ${length.toFixed(1)} s and cannot fit a ${target.toFixed(1)} s loop between 0.5x and 2x speed.`);
}

// A 20 ms sine burst: 1 ms linear attack, then an exponential decay.
export function clickSamples(sampleRate, hz) {
  const n = Math.round(CLICK_S * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = t < CLICK_ATTACK_S ? t / CLICK_ATTACK_S : Math.exp(-(t - CLICK_ATTACK_S) / CLICK_TAU_S);
    out[i] = CLICK_PEAK * env * Math.sin(2 * Math.PI * hz * t);
  }
  return out;
}

// Same parsing as the preset clamp: blank or non-numeric input falls back.
export function clampTempo({ bpm, beatsPerBar, bars } = {}) {
  return {
    bpm: toInt(bpm, MIN_BPM, MAX_BPM, TEMPO_FALLBACK.bpm),
    beatsPerBar: toInt(beatsPerBar, 1, MAX_BEATS, TEMPO_FALLBACK.beatsPerBar),
    bars: toInt(bars, 1, MAX_BARS, TEMPO_FALLBACK.bars)
  };
}

function toInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

// Take states: idle -> countIn -> recording -> idle. The scheduler tick
// drives every transition, and cancelTake() is the only cancel path.
//
// hooks:
//   startRecorder()  start the recorder now; returns the context time read
//                    just before recorder.start()
//   stopRecorder()   stop it; the app then reads consumeGrid() and decodes
//   compensation()   seconds a sung take lags the grid (latency estimate
//                    plus the user's nudge); added to the take offset
//   onStatus(text)
export class LoopEngine {
  // The default timers are wrapped so they run as plain calls. Stored bare
  // and called as this.setTimer(), the browser's setInterval gets the engine
  // as `this` and throws "Illegal invocation"; Node does not check, which is
  // how this shipped once with every test green.
  constructor(engine, { setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = id => clearInterval(id), hooks = {} } = {}) {
    this.engine = engine;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.hooks = hooks;
    this.tempo = clampTempo();
    this.origin = null;
    this.nextBeat = 0;
    this.timer = null;
    this.clickEnabled = true;
    this.clickBuffers = null;
    this.nodes = new Map();
    this.take = null;
    this.pendingGrid = null;
    this.material = null;
    this.loop = null;
    this.lastCountIn = null;
  }

  get running() { return this.origin !== null; }
  get takeState() { return this.take?.state ?? 'idle'; }
  get barSec() { return barSeconds(this.tempo.bpm, this.tempo.beatsPerBar); }
  get hasTake() { return this.material !== null; }
  get looping() { return this.loop !== null; }

  context() {
    const c = this.engine.context;
    if (!c) throw new Error('Start the instrument first.');
    return c;
  }

  // Sets the downbeat of bar 1 a little ahead of now. A running transport
  // keeps its tempo; stop it to change tempo.
  startTransport(tempo = {}) {
    this.beginTransport(tempo);
    this.ensureTimer();
    this.tick();
    return { origin: this.origin, tempo: { ...this.tempo } };
  }

  beginTransport(tempo) {
    const c = this.context();
    if (this.running) return;
    this.tempo = clampTempo(tempo);
    this.origin = c.currentTime + START_LEAD;
    this.nextBeat = 0;
  }

  // Stops clicks and the loop, clears the origin and cancels the take. With
  // keepRecording, a take already recording carries on (a hidden tab keeps
  // recording, as in 0.3.2) and still auto-stops on its own.
  stopAll({ keepRecording = false } = {}) {
    this.stopLoop();
    this.stopTransport();
    if (!(keepRecording && this.take?.state === 'recording')) this.cancelTake();
    if (!this.take) this.stopTimer();
  }

  stopTransport() {
    for (const node of this.nodes.keys()) stopNode(node);
    this.nodes.clear();
    this.origin = null;
    this.nextBeat = 0;
  }

  setClickEnabled(on) { this.clickEnabled = Boolean(on); }

  // Records bars of the grid after a one-bar count-in. From a stopped
  // transport that is origin + 1 bar; while running, 1 to 2 bars away.
  scheduleTake(tempo = {}) {
    const c = this.context();
    if (this.take) throw new Error('A take is already scheduled.');
    const startedTransport = !this.running;
    this.beginTransport(tempo);
    const now = c.currentTime;
    const bar = this.barSec;
    const recordAt = barAtOrAfter(this.origin, now + bar, bar);
    const { bpm, beatsPerBar, bars } = this.tempo;
    this.take = { state: 'countIn', recordAt, stopAt: recordAt + bars * bar + PREROLL, bpm, beatsPerBar, bars, gridLength: bars * bar, offset: 0, startedTransport };
    this.lastCountIn = null;
    this.pendingGrid = null;
    // With the metronome off, beats inside the last lookahead were passed
    // over silently; look at them again so none of the count-in is lost.
    if (!this.clickEnabled) this.nextBeat = Math.max(0, Math.ceil((now - this.origin) / (60 / this.tempo.bpm) - 1e-9));
    this.ensureTimer();
    this.tick();
    return { recordAt };
  }

  // In countIn nothing was recorded. In recording, the recorder stops and
  // the take is kept; consumeGrid() then reports its grid, and a take cut
  // short loads as a free take. Pass stopRecorder false from the app's own
  // stop path, which is already stopping the recorder.
  cancelTake({ stopRecorder = true } = {}) {
    const take = this.take;
    if (!take) return 'idle';
    this.take = null;
    if (take.state === 'countIn') {
      for (const [node, info] of this.nodes) {
        if (info.countInOnly) { stopNode(node); this.nodes.delete(node); }
      }
      // A Record from a stopped transport started the clicks; canceling the
      // count-in stops them again unless a loop now runs on that grid.
      if (take.startedTransport && !this.loop) this.stopTransport();
      this.hooks.onStatus?.('Count-in canceled.');
    } else {
      this.pendingGrid = gridOf(take);
      if (stopRecorder) this.hooks.stopRecorder?.();
    }
    if (!this.running) this.stopTimer();
    return take.state;
  }

  // The grid of the take that last stopped recording, once.
  consumeGrid() {
    const grid = this.pendingGrid;
    this.pendingGrid = null;
    return grid;
  }

  // Decodes a finished take into loop material. A grid take shorter than its
  // grid (stopped early) becomes a free take. elapsed is the recorded wall
  // clock length, checked before decoding. A failure leaves the previous
  // take in place.
  async loadTake(blob, { grid = null, elapsed = 0 } = {}) {
    this.context();
    const t = grid ?? this.tempo;
    if (elapsed > maxDecodeSeconds(barSeconds(t.bpm, t.beatsPerBar))) {
      throw new Error('This take is too long to loop; download it instead.');
    }
    const decoded = await this.engine.decodeTake(blob);
    const offset = grid ? Math.max(0, grid.offset) : 0;
    const available = decoded.duration - offset;
    if (!(available > 0.05)) throw new RangeError(grid ? 'Take ended before the first bar.' : 'This take is too short to loop.');
    const complete = Boolean(grid) && available >= grid.gridLength - PAD_TOLERANCE;
    this.material = { decoded, offset, available, gridLength: complete ? grid.gridLength : null };
    return { duration: decoded.duration, mode: complete ? 'grid' : 'free' };
  }

  // From a stopped transport the loop starts at the new origin; while
  // running, at the first bar line at least MIN_LEAD ahead, where it also
  // replaces a playing loop. Throws RangeError with a message for the user
  // when the take cannot fit, without starting anything.
  playLoop(tempo = {}) {
    const c = this.context();
    const m = this.material;
    if (!m) throw new Error('Record a take first.');
    const t = this.running ? this.tempo : clampTempo(tempo);
    const bar = barSeconds(t.bpm, t.beatsPerBar);
    const target = t.bars * bar;
    const fit = fitLoop({ available: m.available, target, gridLength: m.gridLength, barSec: bar, bpm: t.bpm, beatsPerBar: t.beatsPerBar });
    const wasRunning = this.running;
    this.startTransport(t);
    const now = c.currentTime;
    const when = wasRunning ? barAtOrAfter(this.origin, now + MIN_LEAD, bar) : this.origin;
    const seconds = fit.mode === 'trim' ? target : (m.gridLength ?? m.available);
    const rate = c.sampleRate;
    const buffer = this.engine.makeLoopBuffer(m.decoded, { start: m.offset * rate, frames: seconds * rate });
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = 0;
    source.playbackRate.value = fit.rate;
    source.connect(this.engine.loopBus);
    source.start(when);
    if (this.loop) this.loop.source.stop(when);
    this.loop = { source, when, ...fit };
    return { when, mode: fit.mode, rate: fit.rate, cents: fit.cents, waitMs: Math.max(0, (when - now) * 1000) };
  }

  stopLoop() {
    if (!this.loop) return;
    stopNode(this.loop.source);
    this.loop = null;
  }

  ensureTimer() {
    if (this.timer === null) this.timer = this.setTimer(() => this.tick(), TICK_MS);
  }

  stopTimer() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  tick() {
    const c = this.engine.context;
    if (!c) return;
    const now = c.currentTime;
    if (this.running) this.scheduleClicks(now);
    this.advanceTake(now);
    if (!this.running && !this.take) this.stopTimer();
  }

  // Beats already in the past are dropped, never played late, so a stalled
  // main thread skips clicks instead of firing a burst.
  scheduleClicks(now) {
    const len = 60 / this.tempo.bpm;
    const to = now + LOOKAHEAD;
    const first = Math.ceil((now - this.origin) / len - 1e-9);
    if (first > this.nextBeat) this.nextBeat = first;
    for (; ; this.nextBeat++) {
      const time = this.origin + this.nextBeat * len;
      if (time >= to) break;
      const countIn = this.inCountIn(time);
      if (this.clickEnabled || countIn) this.click(time, this.nextBeat % this.tempo.beatsPerBar === 0, !this.clickEnabled && countIn);
    }
  }

  // The last bar before a grid take always clicks, even with the metronome
  // off, so the singer hears where the take starts.
  inCountIn(time) {
    const take = this.take;
    if (!take) return false;
    return time >= take.recordAt - this.barSec - 1e-6 && time < take.recordAt - 1e-6;
  }

  click(time, accent, countInOnly) {
    const c = this.engine.context;
    if (!this.clickBuffers || this.clickBuffers.context !== c) {
      this.clickBuffers = { context: c, accent: this.engine.createClickBuffer(ACCENT_HZ), beat: this.engine.createClickBuffer(BEAT_HZ) };
    }
    const node = c.createBufferSource();
    node.buffer = accent ? this.clickBuffers.accent : this.clickBuffers.beat;
    node.connect(this.engine.clickBus);
    node.onended = () => { this.nodes.delete(node); };
    node.start(time);
    this.nodes.set(node, { time, countInOnly });
  }

  advanceTake(now) {
    const take = this.take;
    if (!take) return;
    if (take.state === 'countIn') {
      const left = Math.max(1, Math.ceil((take.recordAt - now) / (60 / take.bpm) - 1e-6));
      if (left !== this.lastCountIn) {
        this.lastCountIn = left;
        this.hooks.onStatus?.(`Count-in: ${left} beat${left === 1 ? '' : 's'} to the take.`);
      }
      if (now < take.recordAt - PREROLL) return;
      take.state = 'recording';
      let startCallTime;
      try {
        startCallTime = this.hooks.startRecorder?.();
      } catch (error) {
        this.take = null;
        this.hooks.onStatus?.(error?.message || 'Recording failed to start.');
        return;
      }
      if (!Number.isFinite(startCallTime)) startCallTime = now;
      const comp = Number(this.hooks.compensation?.()) || 0;
      take.offset = Math.max(0, take.recordAt - startCallTime + comp);
      this.hooks.onStatus?.('Recording to the grid.');
    }
    if (take.state === 'recording' && now >= take.stopAt) {
      this.take = null;
      this.pendingGrid = gridOf(take);
      this.hooks.stopRecorder?.();
    }
  }
}

function gridOf(take) {
  const { bpm, beatsPerBar, bars, gridLength, offset } = take;
  return { bpm, beatsPerBar, bars, gridLength, offset };
}

function stopNode(node) {
  try { node.stop(); } catch { /* never started or already stopped */ }
}
