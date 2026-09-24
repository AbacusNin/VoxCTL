import { A4_DEFAULT, clampReference, hzToMidi, quantizeMidiSticky } from './scales.js';

// Turns detector readings into the pitch the synth should play. No smoothing
// happens here: glide runs once, on the audio clock (AudioEngine.setPitch).
// v0.3 also ran a per-frame EMA in Hz, so the same glide setting lasted
// 816 to 1046 ms depending on analysis path and display rate, and because
// the EMA never reset, every phrase swooped in from the last one's note.
//
// A 3-frame median drops single-frame detector glitches, and sticky
// quantizing stops a voice near a degree boundary retriggering every frame.
//
// Free mode has an optional hold, off by default: the output stays put until
// the voice moves further than hysteresisCents. It removes vibrato shallower
// than the setting, turns slow slides into steps of about the setting, and
// can hold a steady offset up to the setting for as long as the voice stays
// there. Quantized mode skips it, because the sticky margin already holds.
export class PitchTracker {
  constructor({ medianFrames = 3 } = {}) {
    this.medianFrames = medianFrames;
    this.referenceA4 = A4_DEFAULT;
    this.reset();
  }

  // Call on every unvoiced frame. The next voiced frame then reports jump,
  // so the engine lands on the new note instead of sliding from the old one.
  reset() {
    this.recent = [];
    this.heldNote = null;
    this.freeHold = null;
    this.jump = true;
  }

  // A reference change re-expresses the pitches already in the median, and
  // the free-mode hold, in the new reference, so the median never mixes two
  // tunings. It does not reset: a reset reports jump, and a reference swept
  // from a knob or a slider drag changes every frame, which would bypass the
  // glide for the whole sweep. The quantized held note is a scale degree, so
  // it stays and simply sounds at the new tuning.
  setReference(hz) {
    const next = clampReference(hz);
    if (next === this.referenceA4) return;
    const shift = 12 * Math.log2(this.referenceA4 / next);
    this.recent = this.recent.map(m => m + shift);
    if (this.freeHold !== null) this.freeHold += shift;
    this.referenceA4 = next;
  }

  // Returns { midi, heldNote, jump }. strength is 0..1 of the pull toward the
  // held scale degree; quantized false means free pitch.
  update(pitchHz, {
    quantized = false, root = 'C', scale = 'chromatic', customCents = null, strength = 1,
    referenceA4 = A4_DEFAULT, hysteresisCents = 0
  } = {}) {
    if (referenceA4 !== this.referenceA4) this.setReference(referenceA4);
    this.recent.push(hzToMidi(pitchHz, this.referenceA4));
    if (this.recent.length > this.medianFrames) this.recent.shift();
    let midi = median(this.recent);
    if (quantized) {
      this.freeHold = null;
      this.heldNote = quantizeMidiSticky(midi, this.heldNote, root, scale, customCents);
      midi += (this.heldNote - midi) * Math.max(0, Math.min(1, strength));
    } else {
      this.heldNote = null;
      const h = Number.isFinite(hysteresisCents) ? Math.max(0, hysteresisCents) : 0;
      if (h > 0 && this.freeHold !== null && Math.abs(midi - this.freeHold) * 100 < h) midi = this.freeHold;
      this.freeHold = midi;
    }
    const jump = this.jump;
    this.jump = false;
    return { midi, heldNote: this.heldNote, jump };
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
