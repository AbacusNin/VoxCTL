import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PresetManager, MAX_PRESET_BYTES, sanitizeState, LIMITS, TEMPO_LIMITS, CONTROL_IDS } from '../src/presets/preset-manager.js';

let store;
beforeEach(() => {
  store = new Map();
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); }
  };
});
afterEach(() => { delete globalThis.localStorage; });

const KEY = 'voxctl.presets.v0.3';
const file = (state, extra = {}) => JSON.stringify({ schema: 'voxctl-preset', schemaVersion: 1, name: 'P', state, ...extra });

test('junk in storage yields no user presets instead of bogus entries', () => {
  for (const raw of ['"hello"', '[1,2,3]', 'null', '{bad json', '42']) {
    store.set(KEY, raw);
    assert.equal(new PresetManager().list().filter(p => !p.factory).length, 0, raw);
  }
});

test('a stored preset with a broken shape loads as a clean state', () => {
  store.set(KEY, JSON.stringify({
    'user:a1': { name: 'A', state: { mappings: { notAnArray: 1 }, scale: 'bogus', root: 'H', glide: 900, filter: 15000, delay: 95, reverb: 95 } },
    'user:a2': { name: 'B', state: { mappings: [null, 7, { id: 'x'.repeat(300000), source: 'evil', destination: '"><svg onload=alert(1)>', amount: '1e9' }] } }
  }));
  const pm = new PresetManager();
  const a = pm.get('user:a1');
  assert.deepEqual(a.mappings, []);
  assert.equal(a.scale, 'minor');
  assert.equal(a.root, 'D');
  assert.deepEqual([a.glide, a.filter, a.delay, a.reverb], [500, 12000, 70, 80]);
  const b = pm.get('user:a2');
  assert.equal(b.mappings.length, 1);
  assert.deepEqual(b.mappings[0], { id: 'map-1', source: 'voice.brightness', destination: 'synth.filterCutoff', amount: 100, curve: 'linear', enabled: true });
});

test('mapping ids stay unique when fallbacks are needed', () => {
  const ids = sanitizeState({ mappings: [{ id: 'map-2' }, { id: 'bad id!' }, { id: 'map-2' }, {}] }).mappings.map(m => m.id);
  assert.equal(new Set(ids).size, 4);
  assert.equal(ids[0], 'map-2');
});

test('inherited keys never resolve as presets', () => {
  const pm = new PresetManager();
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'user:constructor']) {
    assert.equal(pm.getRecord(id), null, id);
    assert.equal(pm.remove(id), false, id);
  }
});

test('import rejects oversized files and wrong shapes', () => {
  const pm = new PresetManager();
  assert.throws(() => pm.importPreset(file({}, { pad: 'x'.repeat(MAX_PRESET_BYTES) })), /too large/);
  assert.throws(() => pm.importPreset('[]'), /Unsupported preset schema/);
  assert.throws(() => pm.importPreset(file([])), /incomplete/);
  assert.throws(() => pm.importPreset(file({}, { name: { toString: 1 } })), /incomplete/);
  assert.throws(() => pm.importPreset(file({}, { name: '   ' })), /incomplete/);
});

test('import cannot pollute prototypes or smuggle extra fields', () => {
  const pm = new PresetManager();
  const id = pm.importPreset('{"schema":"voxctl-preset","schemaVersion":1,"name":"<img src=x onerror=alert(1)>","__proto__":{"polluted":1},"state":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"extra":"x","scale":"custom","root":"F#","customScale":[0,"50",150,1e9,null,-100]}}');
  assert.equal({}.polluted, undefined);
  const record = pm.getRecord(id);
  assert.equal(record.name, '<img src=x onerror=alert(1)> (import)');
  assert.deepEqual(Object.keys(record.state).sort(), ['attack', 'customScale', 'delay', 'filter', 'freeHysteresis', 'glide', 'loudnessCurve', 'mappings', 'output', 'pitchMode', 'quantize', 'referenceA4', 'release', 'reverb', 'root', 'scale', 'waveform']);
  assert.equal(record.state.scale, 'custom');
  assert.equal(record.state.root, 'F#');
  assert.deepEqual(record.state.customScale, [0, 150, -100]);
  assert.equal(Object.getPrototypeOf(record.state), Object.prototype);
});

test('saves in the same millisecond get distinct ids that pass the stored-id check', () => {
  const pm = new PresetManager();
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const ids = Array.from({ length: 40 }, (_, i) => pm.save(`P${i}`, {}));
    assert.equal(new Set(ids).size, 40);
    assert.equal(pm.list().filter(p => !p.factory).length, 40);
    for (const id of ids) assert.match(id, /^user:[a-z0-9]{1,16}$/);
  } finally { Date.now = realNow; }
});

test('export writes schema 2 and round-trips every factory preset and a full user preset', () => {
  const pm = new PresetManager();
  const json = pm.exportPreset('factory:space-choir');
  assert.equal(JSON.parse(json).appVersion, '0.4.0');
  assert.equal(JSON.parse(json).schemaVersion, 2);
  for (const { id, factory } of pm.list()) {
    if (!factory) continue;
    assert.deepEqual(pm.get(pm.importPreset(pm.exportPreset(id))), pm.get(id), id);
  }
  const user = pm.save('Tempo', { bpm: 120, beatsPerBar: 3, bars: 2, referenceA4: 432, midiLearn: [{ cc: 74, param: 'filter' }] });
  const back = pm.get(pm.importPreset(pm.exportPreset(user)));
  assert.deepEqual(back, pm.get(user));
  assert.equal(back.bpm, 120);
  assert.deepEqual(back.midiLearn, [{ cc: 74, param: 'filter' }]);
});

test('a schema 1 file imports with v1 fields only and the Feel fallbacks', () => {
  const pm = new PresetManager();
  const id = pm.importPreset(file({ glide: 90, referenceA4: 432, freeHysteresis: 30, bpm: 150, midiLearn: [{ cc: 1, param: 'filter' }] }));
  const state = pm.get(id);
  assert.equal(state.glide, 90);
  assert.deepEqual([state.referenceA4, state.freeHysteresis, state.attack, state.release, state.loudnessCurve], [440, 0, 54, 105, 0.72]);
  assert.equal('bpm' in state, false);
  assert.equal('midiLearn' in state, false);
});

test('a schema 2 file is clamped and snapped to each slider step', () => {
  const pm = new PresetManager();
  const id = pm.importPreset(file({
    referenceA4: 432.123, freeHysteresis: 12, attack: 999, release: -5, loudnessCurve: '1.5', bpm: 300.6, beatsPerBar: 3.4, bars: 0
  }, { schemaVersion: 2 }));
  const s = pm.get(id);
  assert.deepEqual([s.referenceA4, s.freeHysteresis, s.attack, s.release, s.loudnessCurve, s.bpm, s.beatsPerBar, s.bars],
    [432.1, 12, 500, 5, 1.5, 240, 3, 1]);
});

test('hostile Feel values fall back or clamp', () => {
  const clean = sanitizeState({ referenceA4: '__proto__', attack: -5, loudnessCurve: 'Infinity', freeHysteresis: 99.7 });
  assert.deepEqual([clean.referenceA4, clean.attack, clean.loudnessCurve, clean.freeHysteresis], [440, 1, 0.72, 25]);
  assert.equal(sanitizeState({ referenceA4: 1e9 }).referenceA4, 450);
  assert.equal(sanitizeState({ referenceA4: '440abc' }).referenceA4, 440);
  assert.equal(sanitizeState({ bpm: 'fast' }).bpm, undefined);
});

test('schema versions: newer is refused with its own message, junk is unsupported', () => {
  const pm = new PresetManager();
  assert.throws(() => pm.importPreset(file({}, { schemaVersion: 3 })), /newer VoxCTL \(schema 3\)/);
  for (const v of ['2', 0, 1.5, null]) assert.throws(() => pm.importPreset(file({}, { schemaVersion: v })), /Unsupported preset schema/, String(v));
  assert.throws(() => pm.importPreset(file({}, { schema: 'voice-theremin-preset', schemaVersion: 2 })), /Unsupported/);
});

test('a stored 0.3.2 record reads back with the fallbacks and is never rewritten', () => {
  const raw = JSON.stringify({ 'user:old1': { name: 'Old', state: { pitchMode: 'quantized', glide: 80 }, savedAt: '2026-09-01T00:00:00.000Z' } });
  store.set(KEY, raw);
  const pm = new PresetManager();
  pm.list();
  const state = pm.get('user:old1');
  assert.equal(state.glide, 80);
  assert.deepEqual([state.referenceA4, state.freeHysteresis, state.attack, state.release, state.loudnessCurve], [440, 0, 54, 105, 0.72]);
  for (const key of ['bpm', 'beatsPerBar', 'bars', 'midiLearn']) assert.equal(key in state, false, key);
  assert.equal(store.get(KEY), raw);
});

test('preset bindings are rebuilt, and prototype keys never survive', () => {
  const pm = new PresetManager();
  const id = pm.importPreset('{"schema":"voxctl-preset","schemaVersion":2,"name":"B","state":{"midiLearn":[{"__proto__":{"polluted":1},"cc":2,"param":"glide"}]}}');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(pm.get(id).midiLearn, [{ cc: 2, param: 'glide' }]);
  const hostile = pm.importPreset(file({ midiLearn: [{ cc: 123, param: 'filter' }, { cc: 5, param: 'plugin:../../x:y' }, { cc: 6, param: 'constructor' }, { cc: 7, param: 'output' }] }, { schemaVersion: 2 }));
  assert.deepEqual(pm.get(hostile).midiLearn, [{ cc: 7, param: 'output' }]);
});

test('factory presets carry no tempo and no bindings', () => {
  const pm = new PresetManager();
  for (const { id, factory } of pm.list()) {
    if (!factory) continue;
    for (const key of ['bpm', 'beatsPerBar', 'bars', 'midiLearn']) assert.equal(key in pm.get(id), false, `${id} ${key}`);
  }
});

test('every preset limit matches its control in index.html', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const attrs = id => {
    const tag = html.match(new RegExp(`<input\\b[^>]*\\sid="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `#${id}`);
    return Object.fromEntries([...tag.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  };
  for (const [key, [min, max, fallback, step]] of Object.entries({ ...LIMITS, ...TEMPO_LIMITS })) {
    const a = attrs(CONTROL_IDS[key]);
    assert.deepEqual([Number(a.min), Number(a.max), Number(a.value), Number(a.step ?? 1)], [min, max, fallback, step], key);
  }
});

test('factory presets are already clean', () => {
  const pm = new PresetManager();
  for (const { id, factory } of pm.list()) if (factory) assert.deepEqual(sanitizeState(pm.get(id)), pm.get(id), id);
});
