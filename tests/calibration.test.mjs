import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationEngine } from '../src/audio/calibration.js';

function withStorage(storage, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  return Promise.resolve(fn()).finally(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  });
}

test('calibration still finishes when storage is blocked', () => withStorage({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); }
}, async () => {
  const cal = new CalibrationEngine();
  const done = cal.start(20);
  for (let i = 0; i < 10; i++) cal.ingest({ rms: 0.003 });
  const result = await Promise.race([done, new Promise(r => setTimeout(() => r('hung'), 500))]);
  assert.notEqual(result, 'hung');
  assert.equal(result.persisted, false);
  assert.equal(cal.active, false);
  assert.ok(result.noiseGate > 0.003);
  assert.equal(cal.load(), null);
}));

test('calibration persists when storage works', () => {
  const store = new Map();
  return withStorage({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, async () => {
    const cal = new CalibrationEngine();
    const done = cal.start(20);
    cal.ingest({ rms: 0.002 });
    const result = await done;
    assert.equal(result.persisted, true);
    assert.equal(cal.load().noiseGate, result.noiseGate);
  });
});

test('stored values outside the calibration bounds are rejected', () => {
  const store = new Map();
  return withStorage({ getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, () => {
    const cal = new CalibrationEngine();
    for (const bad of [{ noiseFloor: 1, noiseGate: 1e9 }, { noiseFloor: 0.002, noiseGate: 0.0001 }, { noiseFloor: 'x', noiseGate: 0.01 }, 'hello', null]) {
      store.set(cal.storageKey, JSON.stringify(bad));
      assert.equal(cal.load(), null, JSON.stringify(bad));
    }
    store.set(cal.storageKey, JSON.stringify({ noiseFloor: 0.002, noiseGate: 0.01 }));
    assert.equal(cal.load().noiseGate, 0.01);
  });
});
