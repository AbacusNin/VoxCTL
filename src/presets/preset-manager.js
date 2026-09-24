import { SCALES } from '../mapping/scales.js';
import { MAPPING_SOURCES, MAPPING_DESTINATIONS } from '../mapping/mapping-engine.js';

const FACTORY = {
  'factory:classic': {
    name: 'Classic Theremin',
    state: {
      pitchMode: 'free', scale: 'minor', root: 'D', customScale: [0,200,300,500,700,800,1000], quantize: 100, glide: 45,
      waveform: 'sine', filter: 4200, delay: 18, reverb: 28, output: 65,
      mappings: []
    }
  },
  'factory:magnetic': {
    name: 'Magnetic D Minor',
    state: {
      pitchMode: 'quantized', scale: 'minor', root: 'D', customScale: [0,200,300,500,700,800,1000], quantize: 72, glide: 70,
      waveform: 'triangle', filter: 5100, delay: 24, reverb: 34, output: 62,
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
      mappings: []
    }
  }
};

// Bounds match the index.html controls so a loaded preset lands on the sliders unchanged.
const LIMITS = { quantize: [0, 100, 100], glide: [0, 500, 45], filter: [150, 12000, 4200], delay: [0, 70, 18], reverb: [0, 80, 28], output: [0, 100, 65] };
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const WAVEFORMS = ['sine', 'triangle', 'sawtooth', 'square'];
const CURVES = ['linear', 'square', 'sqrt'];
const USER_ID = /^user:[a-z0-9]{1,16}$/;
const SAFE_ID = /^[\w:-]{1,64}$/;
export const MAX_PRESET_BYTES = 256 * 1024;

export class PresetManager {
  // The key stays at v0.3: renaming it would orphan presets saved by 0.3.0.
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
      schemaVersion: 1,
      appVersion: '0.3.2',
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
    if (!isPlainObject(payload) || payload.schema !== 'voxctl-preset' || payload.schemaVersion !== 1) throw new Error('Unsupported preset schema.');
    if (typeof payload.name !== 'string' || !payload.name.trim() || !isPlainObject(payload.state)) throw new Error('Preset file is incomplete.');
    return this.save(`${payload.name.trim().slice(0, 55)} (import)`, payload.state);
  }
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
  for (const [key, [min, max, fallback]] of Object.entries(LIMITS)) clean[key] = clamp(s[key], min, max, fallback);
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
  return clean;
}

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function clamp(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
