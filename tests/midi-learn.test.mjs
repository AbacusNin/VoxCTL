import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MIDI_LEARN_KEY, MAX_BINDINGS, MAX_BINDINGS_TEXT, LEARNABLE, PLUGIN_PARAM,
  isLearnable, sanitizeBindings, bindCc, unbindCc, ccToSliderValue, loadBindings, saveBindings
} from '../src/midi/midi-learn.js';

const memory = (text = null) => {
  const store = new Map(text === null ? [] : [[MIDI_LEARN_KEY, text]]);
  return { store, getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
};

test('anything but an array of bindings reads as none, including the v0.4 prototype map', () => {
  for (const raw of ['"x"', {}, null, 42, { 74: 'filter' }, undefined]) assert.deepEqual(sanitizeBindings(raw), []);
});

test('bad CCs and params are dropped, good ones kept', () => {
  const bad = [120, 127, 128, -1, 7.5, '74', NaN].map(cc => ({ cc, param: 'glide' }));
  const badParams = ['constructor', '__proto__', 'toString', 'pitchMode', 'bogus', 'plugin:../x:y', 'plugin:A:b', 'plugin:ok:' + 'x'.repeat(33), 42, null]
    .map((param, i) => ({ cc: i + 1, param }));
  const good = [{ cc: 0, param: 'glide' }, { cc: 119, param: 'filter' }, { cc: 5, param: 'plugin:sandbox-lfo:rate' }];
  assert.deepEqual(sanitizeBindings([...bad, ...badParams, ...good, [1, 'x'], null]), [
    { cc: 0, param: 'glide' }, { cc: 5, param: 'plugin:sandbox-lfo:rate' }, { cc: 119, param: 'filter' }
  ]);
});

test('the first binding wins per CC and per param, and entries are rebuilt clean', () => {
  const out = sanitizeBindings([{ cc: 9, param: 'delay' }, { cc: 9, param: 'reverb' }, { cc: 3, param: 'delay' }, { cc: 1, param: 'output' }]);
  assert.deepEqual(out, [{ cc: 1, param: 'output' }, { cc: 9, param: 'delay' }]);
  const parsed = JSON.parse('[{"cc":1,"param":"filter","__proto__":{"polluted":1},"x":2}]');
  const [clean] = sanitizeBindings(parsed);
  assert.deepEqual(Object.keys(clean), ['cc', 'param']);
  assert.equal(Object.getPrototypeOf(clean), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.equal(clean.polluted, undefined);
});

test('only the first 64 entries are scanned, and at most 32 are kept', () => {
  const junk = Array.from({ length: 1000 }, () => ({ cc: 500, param: 'x' }));
  assert.deepEqual(sanitizeBindings([...junk, { cc: 1, param: 'glide' }]), []);
  const many = Array.from({ length: 200 }, (_, i) => ({ cc: i % 120, param: `plugin:p${i}:c` }));
  assert.equal(sanitizeBindings(many).length, MAX_BINDINGS);
});

test('binding replaces the old use of that CC and that param', () => {
  assert.deepEqual(bindCc([{ cc: 74, param: 'delay' }, { cc: 10, param: 'filter' }], 74, 'filter'), [{ cc: 74, param: 'filter' }]);
  assert.throws(() => bindCc([], 123, 'filter'), RangeError);
  assert.throws(() => bindCc([], 5, 'constructor'), RangeError);
  const full = Array.from({ length: 32 }, (_, i) => ({ cc: i, param: `plugin:p${i}:c` }));
  assert.ok(bindCc(full, 100, 'glide').some(b => b.cc === 100 && b.param === 'glide'));
  assert.deepEqual(unbindCc([{ cc: 1, param: 'glide' }, { cc: 2, param: 'filter' }], 1), [{ cc: 2, param: 'filter' }]);
});

test('a CC value lands on the slider range, snapped to its step', () => {
  assert.equal(ccToSliderValue(0, { min: 150, max: 12000, step: 1 }), 150);
  assert.equal(ccToSliderValue(1, { min: 150, max: 12000, step: 1 }), 12000);
  assert.equal(ccToSliderValue(0.5, { min: 150, max: 12000, step: 1 }), 6075);
  assert.equal(ccToSliderValue(64 / 127, { min: 430, max: 450, step: 0.1 }), 440.1);
  const curve = ccToSliderValue(0.3, { min: 0.25, max: 2.5, step: 0.01 });
  assert.ok(/^\d+(\.\d{1,2})?$/.test(String(curve)), String(curve));
  assert.equal(ccToSliderValue(-3, { min: 5, max: 2000, step: 1 }), 5);
  assert.equal(ccToSliderValue(7, { min: 5, max: 2000, step: 1 }), 2000);
});

test('blocked storage, oversized text and bad JSON load as no bindings', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.deepEqual(loadBindings(), []);
    assert.equal(saveBindings([{ cc: 1, param: 'glide' }]), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => { parses++; return parse(...args); };
  try {
    assert.deepEqual(loadBindings(memory('[' + ' '.repeat(MAX_BINDINGS_TEXT) + ']')), []);
    assert.equal(parses, 0);
  } finally {
    JSON.parse = parse;
  }
  assert.deepEqual(loadBindings({ getItem() { throw new Error('nope'); } }), []);
  assert.deepEqual(loadBindings(memory('{not json')), []);
  assert.deepEqual(loadBindings(memory(null)), []);
  assert.equal(saveBindings([], { setItem() { throw new Error('QuotaExceededError'); } }), false);
});

test('bindings round-trip through storage as a sanitized array', () => {
  const s = memory();
  assert.equal(saveBindings([{ cc: 74, param: 'filter', extra: 1 }, { cc: 200, param: 'glide' }], s), true);
  assert.equal(s.store.get(MIDI_LEARN_KEY), '[{"cc":74,"param":"filter"}]');
  assert.deepEqual(loadBindings(s), [{ cc: 74, param: 'filter' }]);
  assert.deepEqual(loadBindings(memory('[{"cc":5,"param":"constructor"}]')), []);
});

test('the plugin param groups match the plugin host id rules', () => {
  const src = readFileSync(new URL('../src/plugins/plugin-host.js', import.meta.url), 'utf8');
  const rule = name => src.match(new RegExp(`const ${name} = /\\^(.+)\\$/;`))[1];
  assert.equal(PLUGIN_PARAM.source, `^plugin:(${rule('PLUGIN_ID')}):(${rule('CONTROL_ID')})$`);
});

test('every learnable name is a fixed control or a plugin param', () => {
  assert.equal(new Set(LEARNABLE).size, LEARNABLE.length);
  for (const p of LEARNABLE) assert.ok(isLearnable(p));
  assert.ok(isLearnable('plugin:sandbox-lfo:rate'));
  assert.ok(!isLearnable('hasOwnProperty'));
});
