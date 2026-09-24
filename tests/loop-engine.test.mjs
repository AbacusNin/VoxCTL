import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LoopEngine, barSeconds, barAtOrAfter, beatsInWindow, fitLoop, clickSamples, clampTempo, maxDecodeSeconds,
  PREROLL, MIN_RATE, MAX_RATE
} from '../src/audio/loop-engine.js';
import { PitchDetector, windowSizeFor } from '../src/audio/pitch-detector.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// A fake engine with the parts LoopEngine uses. Sources record where they
// connect and when they start and stop.
class Source {
  constructor(ctx) { this.ctx = ctx; this.playbackRate = { value: 1 }; this.out = []; this.startAt = null; this.stopAt = null; ctx.sources.push(this); }
  connect(n) { this.out.push(n); }
  start(t) { this.startAt = t; }
  stop(t = this.ctx.currentTime) { this.stopAt = t; }
  end() { this.onended?.(); }
}
class Buf {
  constructor(len, rate) { this.length = len; this.sampleRate = rate; this.duration = len / rate; this.data = new Float32Array(len); }
  getChannelData() { return this.data; }
}
function fakeEngine({ started = true } = {}) {
  const ctx = { currentTime: 10, sampleRate: 48000, sources: [], createBufferSource() { return new Source(this); } };
  const engine = {
    context: started ? ctx : null,
    loopBus: { name: 'loopBus' },
    clickBus: { name: 'clickBus' },
    createClickBuffer: hz => Object.assign(new Buf(960, 48000), { hz }),
    makeLoopBuffer: (decoded, { start, frames }) => Object.assign(new Buf(Math.round(frames), 48000), { start }),
    decodeTake: async blob => new Buf(Math.round(blob.seconds * 48000), 48000)
  };
  const timers = [];
  const hooks = { calls: [], status: [] };
  const loop = new LoopEngine(engine, {
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimer: id => { timers[id - 1].cleared = true; },
    hooks: {
      startRecorder: () => { hooks.calls.push(['start', ctx.currentTime]); return ctx.currentTime; },
      stopRecorder: () => { hooks.calls.push(['stop', ctx.currentTime]); },
      onStatus: t => hooks.status.push(t)
    }
  });
  const run = (until, step = 0.025) => {
    while (ctx.currentTime < until - 1e-9) { ctx.currentTime = Math.min(until, ctx.currentTime + step); loop.tick(); }
  };
  const clicks = () => ctx.sources.filter(s => s.out[0] === engine.clickBus);
  return { ctx, engine, loop, timers, hooks, run, clicks };
}
const TEMPO = { bpm: 96, beatsPerBar: 4, bars: 1 };

// Browsers throw "Illegal invocation" when a native timer is called with a
// `this` other than the global object, which Node does not enforce. The app
// builds LoopEngine without timer options, so the defaults must survive that.
test('the default timers work under browser this-binding rules', () => {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const ids = [];
  function strict(fn) {
    return function (...args) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return fn(...args);
    };
  }
  globalThis.setInterval = strict((fn, ms) => { ids.push(ms); return ids.length; });
  globalThis.clearInterval = strict(() => {});
  try {
    const ctx = { currentTime: 10, sampleRate: 48000, createBufferSource() { return new Source({ ...this, sources: [] }); } };
    const engine = { context: ctx, clickBus: {}, loopBus: {}, createClickBuffer: () => new Buf(960, 48000) };
    const loop = new LoopEngine(engine);
    assert.doesNotThrow(() => loop.startTransport(TEMPO));
    assert.equal(ids.length, 1, 'the scheduler timer was started');
    assert.doesNotThrow(() => loop.stopAll());
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

test('bar arithmetic', () => {
  assert.equal(barSeconds(96, 4), 2.5);
  assert.ok(near(barAtOrAfter(10.1, 12.5, 2.5), 12.6));
  assert.ok(near(barAtOrAfter(10.1, 13.05, 2.5), 15.1));
  assert.ok(near(barAtOrAfter(10.1, 12.6, 2.5), 12.6));
  assert.ok(near(barAtOrAfter(10.1, 5, 2.5), 10.1));
});

test('beats in a window, with the accent on beat 0', () => {
  const beats = beatsInWindow(10.1, 10, 12.6, 96, 4);
  assert.equal(beats.length, 4);
  [10.1, 10.725, 11.35, 11.975].forEach((t, i) => assert.ok(near(beats[i].time, t, 1e-9), `${beats[i].time}`));
  assert.deepEqual(beats.map(b => b.beat), [0, 1, 2, 3]);
  const seven = beatsInWindow(0, 0, 2 * barSeconds(120, 7) - 1e-6, 120, 7);
  assert.equal(seven.length, 14);
  assert.deepEqual(seven.filter(b => b.beat === 0).map(b => seven.indexOf(b)), [0, 7]);
});

test('fitting a take to the loop length', () => {
  assert.deepEqual(fitLoop({ available: 2.5, target: 2.5, gridLength: 2.5 }), { mode: 'trim', rate: 1, cents: 0 });
  const slow = fitLoop({ available: 2.0, target: 2.5 });
  assert.ok(near(slow.rate, 0.8));
  assert.equal(slow.cents, -386);
  assert.ok(near(fitLoop({ available: 5, gridLength: 2.5, target: 2.0 }).rate, 1.25));
  assert.throws(() => fitLoop({ available: 6.0, target: 2.5, barSec: 2.5, bpm: 96, beatsPerBar: 4 }), /fits 2 bars; set Bars to 2/);
  assert.throws(() => fitLoop({ available: 0.9, target: 2.5, barSec: 2.5 }), err => err instanceof RangeError && !/set Bars/.test(err.message));
  assert.throws(() => fitLoop({ available: 0.02, target: 2.5 }), /^RangeError: Take ended before the first bar\.$/);
  for (let a = 0.1; a <= 40; a += 0.07) {
    try {
      const { rate } = fitLoop({ available: a, target: 2.5, barSec: 2.5 });
      assert.ok(rate >= MIN_RATE && rate <= MAX_RATE, `${a}: ${rate}`);
    } catch (error) {
      assert.ok(error instanceof RangeError);
    }
  }
});

test('tempo input is clamped to integers with fallbacks', () => {
  assert.deepEqual(clampTempo({ bpm: '', beatsPerBar: 3.4, bars: 0 }), { bpm: 96, beatsPerBar: 3, bars: 1 });
  assert.equal(clampTempo({ bpm: 300.6 }).bpm, 240);
  assert.deepEqual(clampTempo({ bpm: '120', beatsPerBar: 'x', bars: '99' }), { bpm: 120, beatsPerBar: 4, bars: 16 });
  assert.equal(maxDecodeSeconds(2.5), 81);
  assert.equal(maxDecodeSeconds(60), 600);
});

test('the click is 20 ms, peaks at 0.5 or less, and reads unvoiced in silence', () => {
  for (const rate of [44100, 48000, 96000]) {
    const detector = new PitchDetector(rate);
    const n = windowSizeFor(rate);
    let seed = 3;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.004;
    for (const hz of [1800, 2400]) {
      const click = clickSamples(rate, hz);
      assert.equal(click.length, Math.round(0.02 * rate));
      assert.ok(Math.max(...click.map(Math.abs)) <= 0.5);
      for (let offset = 0; offset < n; offset += 64) {
        const w = new Float32Array(n).map(noise);
        for (let i = 0; i < click.length && offset + i < n; i++) w[offset + i] += click[i] * 0.6;
        assert.equal(detector.detect(w).voiced, false, `${rate} Hz rate, ${hz} Hz click at ${offset}`);
      }
    }
  }
});

test('a quiet click leaking into a sung note moves it by 8 cents or less', () => {
  const rate = 48000;
  const detector = new PitchDetector(rate);
  const n = windowSizeFor(rate);
  const click = clickSamples(rate, 2400);
  for (let offset = 0; offset < n; offset += 64) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) for (let h = 1; h <= 6; h++) w[i] += (0.2 / h) * Math.sin(2 * Math.PI * 220 * h * i / rate + h);
    for (let i = 0; i < click.length && offset + i < n; i++) w[offset + i] += click[i] * 0.3;
    const r = detector.detect(w);
    assert.ok(r.voiced && Math.abs(1200 * Math.log2(r.pitchHz / 220)) <= 8, `offset ${offset}: ${r.pitchHz}`);
  }
});

test('anything that starts sound before the instrument starts says so', async () => {
  const { loop } = fakeEngine({ started: false });
  assert.throws(() => loop.startTransport(TEMPO), /Start the instrument first/);
  assert.throws(() => loop.scheduleTake(TEMPO), /Start the instrument first/);
  assert.throws(() => loop.playLoop(TEMPO), /Start the instrument first/);
  await assert.rejects(loop.loadTake({ seconds: 1 }), /Start the instrument first/);
  assert.doesNotThrow(() => loop.stopAll());
  assert.equal(loop.cancelTake(), 'idle');
});

test('with the metronome off, a grid take clicks the count-in bar and nothing after', () => {
  const { loop, run, clicks, hooks } = fakeEngine();
  loop.setClickEnabled(false);
  const { recordAt } = loop.scheduleTake(TEMPO);
  assert.ok(near(recordAt, 12.6));
  run(16);
  const times = clicks().map(s => s.startAt);
  assert.equal(times.length, 4);
  [10.1, 10.725, 11.35, 11.975].forEach((t, i) => assert.ok(near(times[i], t, 1e-6), `${times[i]}`));
  assert.equal(clicks()[0].buffer.hz, 2400);
  assert.equal(clicks()[1].buffer.hz, 1800);
  assert.ok(hooks.status.some(s => /Count-in: 4 beats/.test(s)));
});

test('with the metronome on, clicks continue past the count-in', () => {
  const { loop, run, clicks } = fakeEngine();
  loop.scheduleTake(TEMPO);
  run(16);
  assert.equal(clicks().filter(s => s.startAt >= 12.6).length, 6);
  const times = clicks().map(s => s.startAt);
  assert.equal(new Set(times.map(t => t.toFixed(6))).size, times.length, 'no beat scheduled twice');
});

test('the recorder starts once at the pre-roll and auto-stops after the bars', () => {
  const { loop, run, hooks } = fakeEngine();
  loop.scheduleTake(TEMPO);
  run(12.6 - PREROLL - 0.03);
  assert.equal(hooks.calls.length, 0);
  assert.equal(loop.takeState, 'countIn');
  run(12.6 - PREROLL + 0.03);
  assert.equal(hooks.calls.length, 1);
  assert.ok(hooks.calls[0][1] >= 12.6 - PREROLL);
  assert.equal(loop.takeState, 'recording');
  run(16);
  assert.deepEqual(hooks.calls.map(c => c[0]), ['start', 'stop']);
  assert.ok(hooks.calls[1][1] >= 12.6 + 2.5 + PREROLL);
  const grid = loop.consumeGrid();
  assert.deepEqual({ ...grid, offset: undefined }, { bpm: 96, beatsPerBar: 4, bars: 1, gridLength: 2.5, offset: undefined });
  assert.ok(grid.offset >= PREROLL - 0.03 && grid.offset <= PREROLL + 0.001, `${grid.offset}`);
  assert.equal(loop.consumeGrid(), null);
});

test('the latency compensation moves the take offset', () => {
  const f = fakeEngine();
  f.loop.hooks.compensation = () => 0.07;
  f.loop.scheduleTake(TEMPO);
  f.run(16);
  const grid = f.loop.consumeGrid();
  assert.ok(grid.offset > 0.2 && grid.offset < 0.25, `${grid.offset}`);
});

test('canceling during the count-in never creates a recorder', () => {
  const { loop, run, hooks, clicks } = fakeEngine();
  loop.setClickEnabled(false);
  loop.scheduleTake(TEMPO);
  run(11);
  assert.equal(loop.cancelTake(), 'countIn');
  run(16);
  assert.equal(hooks.calls.length, 0);
  assert.ok(hooks.status.includes('Count-in canceled.'));
  assert.ok(clicks().every(s => s.startAt < 11.2 || s.stopAt !== null));
});

test('a canceled count-in stops the clicks it started, but not a transport that was already running', () => {
  const a = fakeEngine();
  a.loop.scheduleTake(TEMPO);
  a.run(11);
  a.loop.cancelTake();
  assert.equal(a.loop.running, false);
  const n = a.clicks().length;
  a.run(16);
  assert.equal(a.clicks().length, n, 'no clicks after the cancel');
  assert.ok(a.clicks().every(s => s.startAt < 11 || s.stopAt !== null));
  const b = fakeEngine();
  b.loop.startTransport(TEMPO);
  b.loop.scheduleTake(TEMPO);
  b.run(11);
  b.loop.cancelTake();
  assert.equal(b.loop.running, true, 'the user started this transport');
});

test('canceling while recording stops the recorder and keeps the grid, unless the app is already stopping it', () => {
  const a = fakeEngine();
  a.loop.scheduleTake(TEMPO);
  a.run(13);
  assert.equal(a.loop.cancelTake(), 'recording');
  assert.deepEqual(a.hooks.calls.map(c => c[0]), ['start', 'stop']);
  assert.equal(a.loop.consumeGrid().gridLength, 2.5);
  const b = fakeEngine();
  b.loop.scheduleTake(TEMPO);
  b.run(13);
  b.loop.cancelTake({ stopRecorder: false });
  assert.deepEqual(b.hooks.calls.map(c => c[0]), ['start']);
});

test('a stall drops beats in the past instead of firing them late', () => {
  const { ctx, loop, run, clicks } = fakeEngine();
  loop.startTransport(TEMPO);
  run(11);
  ctx.currentTime = 11.5;
  const before = clicks().length;
  loop.tick();
  const late = clicks().slice(before);
  assert.ok(late.every(s => s.startAt >= 11.5), late.map(s => s.startAt).join());
});

test('finished click nodes are pruned, so the set stays small', () => {
  const { ctx, loop, clicks } = fakeEngine();
  loop.startTransport(TEMPO);
  const end = 10 + 100 * 2.5;
  while (ctx.currentTime < end) {
    ctx.currentTime += 0.025;
    loop.tick();
    for (const s of clicks()) if (s.startAt < ctx.currentTime - 0.02 && !s.ended) { s.ended = true; s.end(); }
  }
  assert.ok(clicks().length >= 400);
  assert.ok(loop.nodes.size <= 2, `${loop.nodes.size}`);
  for (const info of loop.nodes.values()) assert.ok(info.time >= ctx.currentTime - 0.02);
});

test('stopAll stops every node and the loop, clears the interval and the origin', async () => {
  const { loop, run, timers, clicks, ctx } = fakeEngine();
  await loop.loadTake({ seconds: 2.5 });
  loop.playLoop(TEMPO);
  run(10.3);
  loop.stopAll();
  assert.equal(loop.running, false);
  assert.ok(timers.every(t => t.cleared));
  assert.ok(clicks().every(s => s.stopAt !== null));
  assert.ok(ctx.sources.every(s => s.stopAt !== null));
  assert.equal(loop.looping, false);
});

test('a hidden tab can keep a take recording while the click and loop stop', () => {
  const { loop, run, hooks, timers } = fakeEngine();
  loop.scheduleTake(TEMPO);
  run(13);
  loop.stopAll({ keepRecording: true });
  assert.equal(loop.running, false);
  assert.equal(loop.takeState, 'recording');
  run(16);
  assert.deepEqual(hooks.calls.map(c => c[0]), ['start', 'stop']);
  assert.ok(timers.every(t => t.cleared));
});

test('play from a stopped transport starts at the origin; while running, at the next bar', async () => {
  const f = fakeEngine();
  await f.loop.loadTake({ seconds: 2.0 });
  const first = f.loop.playLoop(TEMPO);
  assert.ok(near(first.when, 10.1));
  assert.ok(near(first.rate, 0.8));
  assert.equal(first.cents, -386);
  const src = f.ctx.sources.find(s => s.out[0] === f.engine.loopBus);
  assert.deepEqual(src.out, [f.engine.loopBus]);
  assert.equal(src.loop, true);
  assert.equal(src.buffer.length, 96000);
  f.run(13.0);
  const second = f.loop.playLoop(TEMPO);
  assert.ok(near(second.when, 15.1));
  const loops = f.ctx.sources.filter(s => s.out[0] === f.engine.loopBus);
  assert.equal(loops.length, 2);
  assert.ok(near(loops[1].startAt, 15.1));
  assert.ok(near(loops[0].stopAt, 15.1));
});

test('a complete grid take trims at rate 1; after a tempo change it rate-fits the grid length', async () => {
  const f = fakeEngine();
  const grid = { bpm: 96, beatsPerBar: 4, bars: 1, gridLength: 2.5, offset: 0.16 };
  assert.equal((await f.loop.loadTake({ seconds: 2.5 + 0.16 + 0.15 }, { grid, elapsed: 3 })).mode, 'grid');
  const trim = f.loop.playLoop(TEMPO);
  assert.equal(trim.mode, 'trim');
  const src = f.ctx.sources.find(s => s.out[0] === f.engine.loopBus);
  assert.equal(src.buffer.length, 120000);
  assert.equal(src.buffer.start, 0.16 * 48000);
  f.loop.stopAll();
  const faster = f.loop.playLoop({ ...TEMPO, bpm: 120 });
  assert.ok(near(faster.rate, 1.25));
});

test('a grid take cut short loads as a free take, and one stopped in the pre-roll is refused', async () => {
  const f = fakeEngine();
  const grid = { bpm: 96, beatsPerBar: 4, bars: 1, gridLength: 2.5, offset: 0.15 };
  assert.equal((await f.loop.loadTake({ seconds: 0.15 + 2.0 }, { grid, elapsed: 2.2 })).mode, 'free');
  assert.ok(near(f.loop.playLoop(TEMPO).rate, 0.8));
  await assert.rejects(f.loop.loadTake({ seconds: 0.1 }, { grid, elapsed: 0.1 }), /Take ended before the first bar/);
  // the earlier take is kept
  assert.equal(f.loop.hasTake, true);
});

test('a take too long to ever fit is not decoded', async () => {
  const f = fakeEngine();
  let decoded = 0;
  f.engine.decodeTake = async () => { decoded++; return new Buf(48000, 48000); };
  await assert.rejects(f.loop.loadTake({ seconds: 700 }, { elapsed: 700 }), /too long to loop; download it instead/);
  assert.equal(decoded, 0);
});

test('a take that cannot fit is refused without starting the transport', async () => {
  const f = fakeEngine();
  await f.loop.loadTake({ seconds: 6.0 });
  assert.throws(() => f.loop.playLoop(TEMPO), /set Bars to 2/);
  assert.equal(f.loop.running, false);
});

test('a take scheduled while running keeps its whole count-in, even inside the lookahead', () => {
  const { loop, run, clicks } = fakeEngine();
  loop.setClickEnabled(false);
  loop.startTransport(TEMPO);
  run(12.55);
  assert.equal(clicks().length, 0);
  const { recordAt } = loop.scheduleTake(TEMPO);
  assert.ok(near(recordAt, 15.1));
  run(18);
  const times = clicks().map(s => s.startAt);
  assert.equal(times.length, 4);
  assert.ok(near(times[0], 12.6, 1e-6));
});
