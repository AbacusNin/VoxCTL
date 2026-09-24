import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PresetManager, MAX_PRESET_BYTES, sanitizeState } from '../src/presets/preset-manager.js';

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
  assert.deepEqual(Object.keys(record.state).sort(), ['customScale', 'delay', 'filter', 'glide', 'mappings', 'output', 'pitchMode', 'quantize', 'reverb', 'root', 'scale', 'waveform']);
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

test('export round-trips through import with the current app version', () => {
  const pm = new PresetManager();
  const json = pm.exportPreset('factory:space-choir');
  assert.equal(JSON.parse(json).appVersion, '0.3.2');
  const id = pm.importPreset(json);
  assert.deepEqual(pm.get(id), pm.get('factory:space-choir'));
});

test('factory presets are already clean', () => {
  const pm = new PresetManager();
  for (const { id, factory } of pm.list()) if (factory) assert.deepEqual(sanitizeState(pm.get(id)), pm.get(id), id);
});
