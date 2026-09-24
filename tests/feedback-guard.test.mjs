import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedbackGuard } from '../src/audio/feedback-guard.js';

const FRAME = 30;

// Runs the guard against a mic model. mic(synthOn, t) returns what the mic
// hears given whether the synth was sounding latencyMs ago. The latency
// stands in for the whole round trip: gain ramp, output buffer, air, input
// buffer, and the analysis window. The first version of this harness used a
// single frame, which hid a guard that decided before the loop had collapsed.
function run(mic, ms, latencyMs = 0) {
  const g = new FeedbackGuard();
  const actions = [];
  const history = [];
  for (let t = 0; t < ms; t += FRAME) {
    const past = history.findLast(h => h.t <= t - latencyMs);
    const a = g.update(t, mic(past ? past.on : false, t));
    actions.push(a);
    history.push({ t, on: a === 'play' });
  }
  return actions;
}

test('a singer holding a note is never flagged', () => {
  const singer = () => ({ voiced: true, rms: 0.05 });
  const actions = run(singer, 60000, 120);
  assert.ok(!actions.includes('feedback'));
  assert.ok(actions.includes('probe'), 'should have probed a long note');
  // about one 300 ms gap per 20 s of unbroken singing
  const gapMs = actions.filter(a => a === 'probe').length * FRAME;
  assert.ok(gapMs <= 3 * 330, `${gapMs} ms of gaps in 60 s`);
});

for (const latencyMs of [30, 120, 250]) {
  test(`a speaker feedback loop is caught with ${latencyMs} ms round trip`, () => {
    // Sustains itself only while the synth plays.
    const loop = (synthOn, t) => (t < 500 || synthOn ? { voiced: true, rms: 0.05 } : { voiced: false, rms: 0.001 });
    const actions = run(loop, 8000, latencyMs);
    const tripped = actions.indexOf('feedback');
    assert.ok(tripped > 0 && tripped * FRAME < 4000, `tripped at ${tripped * FRAME} ms`);
  });
}

test('the guard rearms once the mic goes quiet', () => {
  const g = new FeedbackGuard();
  g.state = 'tripped';
  assert.equal(g.update(0, { voiced: false, rms: 0 }), 'feedback');
  assert.equal(g.update(1100, { voiced: false, rms: 0 }), 'play');
  assert.equal(g.update(1200, { voiced: true, rms: 0.05 }), 'play');
});
