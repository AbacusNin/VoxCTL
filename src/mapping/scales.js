const ROOTS = { C:0, 'C#':1, D:2, 'D#':3, E:4, F:5, 'F#':6, G:7, 'G#':8, A:9, 'A#':10, B:11 };

export const NOTE_NAMES = Object.keys(ROOTS);

export const SCALES = {
  chromatic: Array.from({ length: 12 }, (_, i) => i),
  major: [0,2,4,5,7,9,11],
  minor: [0,2,3,5,7,8,10],
  pentatonic: [0,2,4,7,9],
  blues: [0,3,5,6,7,10],
  dorian: [0,2,3,5,7,9,10],
  phrygian: [0,1,3,5,7,8,10],
  wholeTone: [0,2,4,6,8,10]
};

// Same cap presets enforce; a pasted list longer than this is truncated.
export const MAX_CUSTOM_DEGREES = 128;

// Plain decimal cents only, so '0x10' or '1e3' is not read as a pitch.
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

// A4 reference tuning. Every MIDI number in the app is in reference space:
// note 69 is A4 at the reference, so quantizing, custom cents scales and MIDI
// out follow the tuning without knowing about it.
export const A4_DEFAULT = 440;
export const A4_MIN = 430;
export const A4_MAX = 450;

// Same parsing as the preset clamp. Number('') is 0, which would clamp to
// 430, so blank and non-numeric input fall back to 440 instead.
export function clampReference(hz) {
  const value = typeof hz === 'string' && hz.trim() !== '' ? Number(hz) : hz;
  if (typeof value !== 'number' || !Number.isFinite(value)) return A4_DEFAULT;
  return Math.max(A4_MIN, Math.min(A4_MAX, value));
}

export function hzToMidi(hz, a4 = A4_DEFAULT) { return 69 + 12 * Math.log2(hz / a4); }
export function midiToHz(midi, a4 = A4_DEFAULT) { return a4 * Math.pow(2, (midi - 69) / 12); }

// Cents from the nearest equal-tempered semitone of the reference, -50..+50.
export function centsOffset(hz, a4 = A4_DEFAULT) {
  const m = hzToMidi(hz, a4);
  return (m - Math.round(m)) * 100;
}
export function midiToNote(midi) {
  const rounded = Math.round(midi);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

export function parseCustomScale(text) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(token => DECIMAL.test(token));
  return normalizeCents(tokens.map(Number));
}

// Sorted, unique degrees in [0, 1200), always including 0. Rounding comes
// before the octave wrap: wrapping first let 1199.9996 round up to a
// spurious 1200 degree.
export function normalizeCents(values) {
  const set = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    if (set.size >= MAX_CUSTOM_DEGREES) break;
    if (!Number.isFinite(raw)) continue;
    const value = ((Math.round(raw * 1000) / 1000) % 1200 + 1200) % 1200;
    set.add(value >= 1199.9995 ? 0 : value);
  }
  set.add(0);
  return [...set].sort((a, b) => a - b);
}

export function formatCustomScale(cents) {
  return (Array.isArray(cents) ? cents : [0]).map(value => Number(value).toFixed(Number.isInteger(value) ? 0 : 2)).join(', ');
}

// Degrees of the active scale in cents from the root. customCents may be the
// textarea string or an already-parsed array; passing the array saves a parse
// per frame.
export function scaleOffsets(scaleName, customCents = null) {
  if (scaleName === 'custom') {
    return Array.isArray(customCents) ? normalizeCents(customCents) : parseCustomScale(customCents);
  }
  return (SCALES[scaleName] || SCALES.chromatic).map(semitones => semitones * 100);
}

export function quantizeMidi(midi, rootName, scaleName, customCents = null) {
  return snap(midi, ROOTS[rootName] ?? 0, scaleOffsets(scaleName, customCents));
}

// Like quantizeMidi, but holds the previous note until the voice is closer to
// a neighbor by more than margin semitones. Without this, a voice sitting
// halfway between two scale degrees flips between them every frame, in the
// synth and as a note-on storm on MIDI out.
export function quantizeMidiSticky(midi, prev, rootName, scaleName, customCents = null, margin = 0.25) {
  const root = ROOTS[rootName] ?? 0;
  const offsets = scaleOffsets(scaleName, customCents);
  const snapped = snap(midi, root, offsets);
  if (!Number.isFinite(prev) || prev === snapped) return snapped;
  // prev may belong to a scale or root the user has since switched away from.
  const cents = ((((prev - root) * 100) % 1200) + 1200) % 1200;
  const inScale = offsets.some(o => Math.abs(o - cents) < 0.01 || Math.abs(o - cents + 1200) < 0.01);
  if (!inScale) return snapped;
  return Math.abs(midi - prev) < Math.abs(midi - snapped) + margin ? prev : snapped;
}

function snap(midi, root, offsets) {
  let best = midi;
  let bestDistance = Infinity;
  const centerOctave = Math.floor(midi / 12);
  for (let octave = centerOctave - 2; octave <= centerOctave + 2; octave++) {
    for (const cents of offsets) {
      const candidate = octave * 12 + root + cents / 100;
      const distance = Math.abs(candidate - midi);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
}
