// Catches the synth hearing itself through speakers. Echo cancellation is off
// and output level follows mic level, so a speaker loop sustains itself. In
// free mode the synth copies the voice, so matching pitch cannot tell a
// singer from a loop. Instead, once a sound has held steady long enough to be
// suspicious, the synth is muted briefly. A singer keeps going through the
// gap; a feedback loop loses its source and the mic level collapses.
//
// The collapse arrives late: gain ramp, output and input buffers, the air,
// and the analysis window all sit between muting and the mic hearing it,
// and Bluetooth output adds a couple hundred ms more. So the probe watches
// the lowest level across its whole length and trips the moment it falls,
// rather than taking one reading at the end.
//
// Loop playback of a recorded take is a second speaker path this guard does
// not catch: muting the synth leaves the take playing, so the mic level does
// not collapse. For the same reason a loop on speakers also hides a synth
// loop: once playback made up 30% or more of the mic level, a simulated synth
// loop was never caught. The UI warns about both next to the loop controls.
//
// update() returns what the synth should do this frame:
//   'play'     normal
//   'probe'    mute, a probe is in progress
//   'feedback' mute, a loop was confirmed; rearms after the mic goes quiet
export class FeedbackGuard {
  constructor({ holdMs = 3000, probeMs = 300, dropRatio = 0.3, cooldownMs = 20000, rearmMs = 1000 } = {}) {
    Object.assign(this, { holdMs, probeMs, dropRatio, cooldownMs, rearmMs });
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.voicedSince = null;
    this.lastProbe = -Infinity;
    this.probeStart = 0;
    this.rmsBefore = 0;
    this.probeMin = Infinity;
    this.quietSince = null;
  }

  update(now, { voiced, rms }) {
    if (this.state === 'probing') {
      this.probeMin = Math.min(this.probeMin, rms);
      if (this.probeMin < this.rmsBefore * this.dropRatio) {
        this.state = 'tripped';
        this.quietSince = null;
        return 'feedback';
      }
      if (now - this.probeStart < this.probeMs) return 'probe';
      this.state = 'idle';
      this.lastProbe = now;
      this.voicedSince = now;
      return 'play';
    }

    if (this.state === 'tripped') {
      if (voiced) {
        this.quietSince = null;
        return 'feedback';
      }
      this.quietSince ??= now;
      if (now - this.quietSince < this.rearmMs) return 'feedback';
      this.reset();
      return 'play';
    }

    if (!voiced) {
      this.voicedSince = null;
      return 'play';
    }
    this.voicedSince ??= now;
    if (now - this.voicedSince >= this.holdMs && now - this.lastProbe >= this.cooldownMs) {
      this.state = 'probing';
      this.probeStart = now;
      this.rmsBefore = rms;
      this.probeMin = Infinity;
      return 'probe';
    }
    return 'play';
  }
}
