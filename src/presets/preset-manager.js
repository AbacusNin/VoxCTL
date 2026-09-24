import { SCALES, A4_MIN, A4_MAX, A4_DEFAULT } from '../mapping/scales.js';
import { MAPPING_SOURCES, MAPPING_DESTINATIONS } from '../mapping/mapping-engine.js';
import { DYNAMICS_LIMITS, DYNAMICS_DEFAULTS } from '../audio/audio-engine.js';
import { MIN_BPM, MAX_BPM, MAX_BEATS, MAX_BARS } from '../audio/loop-engine.js';
import { sanitizeBindings } from '../midi/midi-learn.js';

export const SCHEMA_VERSION = 2;

// Feel defaults that reproduce 0.3.2: A4 440, no free-mode hold, curve 0.72,
// and attack and release matching its 18 ms and 35 ms time constants.
const FEEL = {
  referenceA4: A4_DEFAULT, freeHysteresis: 0,
  attack: DYNAMICS_DEFAULTS.attackMs, release: DYNAMICS_DEFAULTS.releaseMs, loudnessCurve: DYNAMICS_DEFAULTS.curve
};

const FACTORY = {
  'factory:classic': {
    name: 'Classic Theremin',
    state: {
      pitchMode: 'free', scale: 'minor', root: 'D', customScale: [0,200,300,500,700,800,1000], quantize: 100, glide: 45,
      waveform: 'sine', filter: 4200, delay: 18, reverb: 28, output: 65,
      ...FEEL,
      mappings: []
    }
  },
  'factory:magnetic': {
    name: 'Magnetic D Minor',
    state: {
      pitchMode: 'quantized', scale: 'minor', root: 'D', customScale: [0,200,300,500,700,800,1000], quantize: 72, glide: 70,
      waveform: 'triangle', filter: 5100, delay: 24, reverb: 34, output: 62,
      ...FEEL,
      mappings: [
        { id: 'map-1', source: 'voice.brightness', destination: 'synth.filterCutoff', amount: 42, curve: 'linear', enabled: true }
      ]
    }
  },
  'factory:space-choir': {
    name: 'Space Choir',
    state: {
      pitchMode: 'quantized', scale: 'pentatonic', root: 'A', customScale: [0,200,400,700,900], quantize: 86, glide: 120,
      waveform: 'sawtooth', filter: 3000, delay: 36, reverb: 58, output: 52,
      ...FEEL,
      mappings: [
        { id: 'map-1', source: 'voice.brightness', destination: 'synth.filterCutoff', amount: 55, curve: 'sqrt', enabled: true },
        { id: 'map-2', source: 'voice.vibratoDepth', destination: 'fx.reverbMix', amount: 35, curve: 'linear', enabled: true }
      ]
    }
  },
  'factory:quarter-tone': {
    name: 'Quarter-Tone Lab',
    state: {
      pitchMode: 'quantized', scale: 'custom', root: 'C', customScale: Array.from({ length: 24 }, (_, i) => i * 50), quantize: 100, glide: 34,
      waveform: 'sine', filter: 5600, delay: 12, reverb: 22, output: 58,
      ...FEEL,
      mappings: []
    }
  }
};

// [min, max, fallback, step]. Bounds, defaults and steps match the index.html
// controls (tests/presets.test.mjs parses them), so a loaded preset lands on
// the sliders unchanged. The dynamics ranges come from the engine, so the
// sliders, the engine, presets and MIDI learn share one set.
export const LIMITS = {
  quantize: [0, 100, 100, 1], glide: [0, 500, 45, 1], filter: [150, 12000, 4200, 1], delay: [0, 70, 18, 1], reverb: [0, 80, 28, 1], output: [0, 100, 65, 1],
  referenceA4: [A4_MIN, A4_MAX, A4_DEFAULT, 0.1],
  freeHysteresis: [0, 25, 0, 1],
  attack: [...DYNAMICS_LIMITS.attackMs, DYNAMICS_DEFAULTS.attackMs, 1],
  release: [...DYNAMICS_LIMITS.releaseMs, DYNAMICS_DEFAULTS.releaseMs, 1],
  loudnessCurve: [...DYNAMICS_LIMITS.curve, DYNAMICS_DEFAULTS.curve, 0.01]
};
// Optional: a key is written only when the source carries a number for it,
// so factory presets, 0.3.x presets and schema 1 files never reset the
// user's tempo.
export const TEMPO_LIMITS = { bpm: [MIN_BPM, MAX_BPM, 96, 1], beatsPerBar: [1, MAX_BEATS, 4, 1], bars: [1, MAX_BARS, 1, 1] };
// Preset key to the index.html control that shows it.
export const CONTROL_IDS = {
  quantize: 'quantizeStrength', glide: 'glide', filter: 'filterCutoff', delay: 'delayMix', reverb: 'reverbMix', output: 'outputGain',
  referenceA4: 'referenceA4', freeHysteresis: 'freeHysteresis', attack: 'attack', release: 'release', loudnessCurve: 'loudnessCurve',
  bpm: 'loopBpm', beatsPerBar: 'loopBeats', bars: 'loopBars'
};
// The fields a schema 1 file may carry. Anything else in its state is dropped
// on import, so a v1 file cannot pick up v2 fields by accident.
const V1_KEYS = ['pitchMode', 'scale', 'root', 'customScale', 'waveform', 'quantize', 'glide', 'filter', 'delay', 'reverb', 'output', 'mappings'];
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const WAVEFORMS = ['sine', 'triangle', 'sawtooth', 'square'];
const CURVES = ['linear', 'square', 'sqrt'];
const USER_ID = /^user:[a-z0-9]{1,16}$/;
const SAFE_ID = /^[\w:-]{1,64}$/;
export const MAX_PRESET_BYTES = 256 * 1024;

export class PresetManager {
  // The key stays at v0.3. Renaming it would orphan 0.3.x presets, and
  // keeping it lets 0.3.2 still read them after a downgrade: its
  // sanitizeState drops the keys it does not know, and its writeUser keeps
  // other records as stored. Migration is lazy: sanitizeState runs on every
  // read and nothing is rewritten on load.
  constructor(storageKey = 'voxctl.presets.v0.3') { this.storageKey = storageKey; }

  // Storage is shared with every page on the origin (all GitHub Pages project
  // sites of one account), so keep only entries save() could have written.
  readUser() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(this.storageKey)); } catch { return {}; }
    if (!isPlainObject(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([id, p]) =>
      USER_ID.test(id) && isPlainObject(p) && typeof p.name === 'string' && p.name.length <= 64 && isPlainObject(p.state)));
  }

  writeUser(presets) { localStorage.setItem(this.storageKey, JSON.stringify(presets)); }

  list() {
    const user = this.readUser();
    return [
      ...Object.entries(FACTORY).map(([id, p]) => ({ id, name: p.name, factory: true })),
      ...Object.entries(user).map(([id, p]) => ({ id, name: p.name, factory: false }))
    ];
  }

  getRecord(id) {
    if (Object.hasOwn(FACTORY, id)) return { id, name: FACTORY[id].name, state: sanitizeState(FACTORY[id].state), factory: true };
    const user = this.readUser();
    if (!Object.hasOwn(user, id)) return null;
    return { id, name: user[id].name, state: sanitizeState(user[id].state), factory: false };
  }

  get(id) { return this.getRecord(id)?.state || null; }

  save(name, state) {
    const clean = String(name ?? '').trim().slice(0, 64);
    if (!clean) throw new Error('Preset name is required.');
    const user = this.readUser();
    // Two saves in the same millisecond must not share an id.
    const stamp = Date.now().toString(36);
    let id = `user:${stamp}`;
    for (let n = 0; Object.hasOwn(user, id); n++) id = `user:${stamp}${n.toString(36)}`;
    user[id] = { name: clean, state: sanitizeState(state), savedAt: new Date().toISOString() };
    this.writeUser(user);
    return id;
  }

  remove(id) {
    if (!USER_ID.test(String(id))) return false;
    const user = this.readUser();
    if (!Object.hasOwn(user, id)) return false;
    delete user[id];
    this.writeUser(user);
    return true;
  }

  exportPreset(id) {
    const record = this.getRecord(id);
    if (!record) throw new Error('Preset not found.');
    return JSON.stringify({
      schema: 'voxctl-preset',
      schemaVersion: SCHEMA_VERSION,
      appVersion: '0.4.0',
      name: record.name,
      state: record.state,
      exportedAt: new Date().toISOString()
    }, null, 2);
  }

  importPreset(jsonText) {
    const text = String(jsonText ?? '');
    if (text.length > MAX_PRESET_BYTES) throw new Error('Preset file is too large (256 KB maximum).');
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error('Preset file is not valid JSON.'); }
    if (!isPlainObject(payload) || payload.schema !== 'voxctl-preset') throw new Error('Unsupported preset schema.');
    const version = payload.schemaVersion;
    if (Number.isInteger(version) && version > SCHEMA_VERSION) {
      throw new Error(`This preset was made by a newer VoxCTL (schema ${version}). Update VoxCTL to import it.`);
    }
    if (version !== 1 && version !== 2) throw new Error('Unsupported preset schema.');
    if (typeof payload.name !== 'string' || !payload.name.trim() || !isPlainObject(payload.state)) throw new Error('Preset file is incomplete.');
    return this.save(`${payload.name.trim().slice(0, 55)} (import)`, migrateState(version, payload.state));
  }
}

// Schema 1 keeps only its own fields, which then take the v2 fallbacks.
export function migrateState(version, state) {
  if (version !== 1) return sanitizeState(state);
  const s = isPlainObject(state) ? state : {};
  const v1 = {};
  for (const key of V1_KEYS) if (Object.hasOwn(s, key)) v1[key] = s[key];
  return sanitizeState(v1);
}

// Builds a new object from known fields only, so unknown keys, __proto__ and
// oversized strings never reach storage or the UI.
export function sanitizeState(state) {
  const s = isPlainObject(state) ? state : {};
  const clean = {
    pitchMode: s.pitchMode === 'quantized' ? 'quantized' : 'free',
    scale: s.scale === 'custom' || Object.hasOwn(SCALES, s.scale) ? s.scale : 'minor',
    root: ROOTS.includes(s.root) ? s.root : 'D',
    customScale: Array.isArray(s.customScale)
      ? s.customScale.filter(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 12000).slice(0, 128)
      : [0, 200, 300, 500, 700, 800, 1000],
    waveform: WAVEFORMS.includes(s.waveform) ? s.waveform : 'sine'
  };
  for (const [key, [min, max, fallback, step]] of Object.entries(LIMITS)) clean[key] = snap(clamp(s[key], min, max, fallback), min, max, step);
  for (const [key, [min, max, , step]] of Object.entries(TEMPO_LIMITS)) {
    const n = toNumber(s[key]);
    if (Number.isFinite(n)) clean[key] = snap(Math.max(min, Math.min(max, n)), min, max, step);
  }
  const mappings = Array.isArray(s.mappings) ? s.mappings.filter(isPlainObject).slice(0, 64) : [];
  // Rows are edited by id, so ids must be unique as well as safe.
  const used = new Set();
  const uniqueId = id => {
    if (typeof id !== 'string' || !SAFE_ID.test(id) || used.has(id)) {
      let n = used.size + 1;
      while (used.has(`map-${n}`)) n++;
      id = `map-${n}`;
    }
    used.add(id);
    return id;
  };
  clean.mappings = mappings.map(m => ({
    id: uniqueId(m.id),
    source: MAPPING_SOURCES.includes(m.source) ? m.source : 'voice.brightness',
    destination: MAPPING_DESTINATIONS.includes(m.destination) ? m.destination : 'synth.filterCutoff',
    amount: clamp(m.amount, -100, 100, 0),
    curve: CURVES.includes(m.curve) ? m.curve : 'linear',
    enabled: m.enabled !== false
  }));
  // Rebuilt objects from an allowlist; an empty list writes no key.
  const bindings = sanitizeBindings(s.midiLearn);
  if (bindings.length) clean.midiLearn = bindings;
  return clean;
}

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function toNumber(value) {
  return typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
}

function clamp(value, min, max, fallback) {
  const n = toNumber(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

// clamp() does not round, so a value lands on the slider's step here, with
// the float error of the multiply rounded away.
function snap(value, min, max, step) {
  const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  const v = Number((min + Math.round((value - min) / step) * step).toFixed(decimals));
  return Math.max(min, Math.min(max, v));
}
