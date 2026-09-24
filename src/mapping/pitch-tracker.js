import { hzToMidi, quantizeMidiSticky } from './scales.js';

// Turns detector readings into the pitch the synth should play. No smoothing
// happens here: glide runs once, on the audio clock (AudioEngine.setPitch).
// v0.3 also ran a per-frame EMA in Hz, so the same glide setting lasted
// 816 to 1046 ms depending on analysis path and display rate, and because
// the EMA never reset, every phrase swooped in from the last one's note.
//
// A 3-frame median drops single-frame detector glitches, and sticky
// quantizing stops a voice near a degree boundary retriggering every frame.
export class PitchTracker {
  constructor({ medianFrames = 3 } = {}) {
    this.medianFrames = medianFrames;
    this.reset();
  }

  // Call on every unvoiced frame. The next voiced frame then reports jump,
  // so the engine lands on the new note instead of sliding from the old one.
  reset() {
    this.recent = [];
    this.heldNote = null;
    this.jump = true;
  }

  // Returns { midi, heldNote, jump }. strength is 0..1 of the pull toward the
  // held scale degree; quantized false means free pitch.
  update(pitchHz, { quantized = false, root = 'C', scale = 'chromatic', customCents = null, strength = 1 } = {}) {
    this.recent.push(hzToMidi(pitchHz));
    if (this.recent.length > this.medianFrames) this.recent.shift();
    let midi = median(this.recent);
    if (quantized) {
      this.heldNote = quantizeMidiSticky(midi, this.heldNote, root, scale, customCents);
      midi += (this.heldNote - midi) * Math.max(0, Math.min(1, strength));
    } else {
      this.heldNote = null;
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
