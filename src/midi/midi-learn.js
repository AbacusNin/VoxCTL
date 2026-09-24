// MIDI learn: bindings from a controller's CC number to a UI slider. Pure,
// no DOM. Bindings come from browser storage and from preset files, and
// every GitHub Pages project site of an account shares one origin, so
// everything read is rebuilt from scratch: an array of { cc, param } with an
// integer CC, an allowlisted or plugin-pattern param, one binding per CC and
// one per param.

export const MIDI_LEARN_KEY = 'voxctl.midiLearn.v0.4';
// CCs 120 to 127 are channel mode messages (All Sound Off, Reset, All Notes
// Off and so on). A controller's panic button sends them, so they never bind.
export const MAX_LEARN_CC = 119;
export const MAX_BINDINGS = 32;
export const MAX_SCAN = 64;
export const MAX_BINDINGS_TEXT = 4096;

export const LEARNABLE = Object.freeze([
  'quantize', 'glide', 'referenceA4', 'freeHysteresis', 'filter', 'delay', 'reverb', 'output',
  'attack', 'release', 'loudnessCurve', 'loopLevel', 'clickLevel'
]);

// plugin:<plugin id>:<control id>. The two groups copy the plugin host's
// PLUGIN_ID and CONTROL_ID rules rather than importing them, so plugin-host.js
// and its CSP hash stay untouched; a test checks the two agree.
export const PLUGIN_PARAM = /^plugin:([a-z0-9-]{1,40}):([a-z0-9_-]{1,32})$/;

export function isLearnable(param) {
  return typeof param === 'string' && (LEARNABLE.includes(param) || PLUGIN_PARAM.test(param));
}

function isLearnableCc(cc) {
  return typeof cc === 'number' && Number.isInteger(cc) && cc >= 0 && cc <= MAX_LEARN_CC;
}

// Scans at most MAX_SCAN entries so a huge array costs nothing, keeps the
// first binding per CC and per param, stops at MAX_BINDINGS, and returns
// them sorted by CC.
export function sanitizeBindings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const ccs = new Set();
  const params = new Set();
  for (const entry of raw.slice(0, MAX_SCAN)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { cc, param } = entry;
    if (!isLearnableCc(cc) || !isLearnable(param) || ccs.has(cc) || params.has(param)) continue;
    ccs.add(cc);
    params.add(param);
    out.push({ cc, param });
    if (out.length === MAX_BINDINGS) break;
  }
  return out.sort((a, b) => a.cc - b.cc);
}

// A new binding replaces any binding for the same CC or the same param.
export function bindCc(bindings, cc, param) {
  if (!isLearnableCc(cc)) throw new RangeError(`CC ${cc} cannot be learned; use 0 to ${MAX_LEARN_CC}.`);
  if (!isLearnable(param)) throw new RangeError('That control cannot be learned.');
  const rest = sanitizeBindings(bindings).filter(b => b.cc !== cc && b.param !== param);
  // The new binding goes first so it survives the cap.
  return sanitizeBindings([{ cc, param }, ...rest]);
}

export function unbindCc(bindings, cc) {
  return sanitizeBindings(bindings).filter(b => b.cc !== cc);
}

// A 0..1 CC value on a slider's range, snapped to its step. The slider jumps
// to the knob; there is no pickup.
export function ccToSliderValue(value01, { min, max, step }) {
  const x = Math.max(0, Math.min(1, Number(value01) || 0));
  let v = min + (max - min) * x;
  if (Number.isFinite(step) && step > 0) {
    v = min + Math.round((v - min) / step) * step;
    v = Number(v.toFixed(decimals(step)));
  }
  return Math.max(min, Math.min(max, v));
}

function decimals(step) {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

// Storage is read inside the try: with site data blocked, Chrome throws
// SecurityError on the localStorage getter itself.
export function loadBindings(storage) {
  let text;
  try {
    text = (storage ?? globalThis.localStorage).getItem(MIDI_LEARN_KEY);
  } catch {
    return [];
  }
  if (typeof text !== 'string' || text.length > MAX_BINDINGS_TEXT) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return sanitizeBindings(parsed);
}

// False when storage is blocked or full; the bindings then last this session.
export function saveBindings(bindings, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(MIDI_LEARN_KEY, JSON.stringify(sanitizeBindings(bindings)));
    return true;
  } catch {
    return false;
  }
}
