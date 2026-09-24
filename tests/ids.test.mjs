import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MappingEngine } from '../src/mapping/mapping-engine.js';
import { PresetManager } from '../src/presets/preset-manager.js';

const EVIL = '"><img src=x onerror=alert(1)>';

test('mapping ids outside a plain token are replaced', () => {
  const m = new MappingEngine([{ id: EVIL, source: 'voice.rms', destination: 'fx.delayMix', amount: 10 }, { id: 'map-7' }]);
  const [a, b] = m.getMappings();
  assert.equal(a.id, 'map-1');
  assert.equal(b.id, 'map-7');
});

test('stored presets with forged ids or bad shapes are dropped', () => {
  const stored = {
    [EVIL]: { name: 'x', state: {} },
    'user:abc123': { name: 'Mine', state: { glide: 90 } },
    'user:nostate': { name: 'broken' },
    'user:noname': { state: {} }
  };
  globalThis.localStorage = { getItem: () => JSON.stringify(stored), setItem() {} };
  try {
    const user = new PresetManager().list().filter(p => !p.factory);
    assert.deepEqual(user.map(p => p.id), ['user:abc123']);
  } finally {
    delete globalThis.localStorage;
  }
});
