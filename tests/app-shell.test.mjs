// Static checks on the shipped files: the offline cache, the element ids the
// app binds, the release version, and the publishing rules for text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { LEARNABLE } from '../src/midi/midi-learn.js';
import { A4_MIN, A4_MAX } from '../src/mapping/scales.js';
import { DYNAMICS_LIMITS } from '../src/audio/audio-engine.js';
import { LIMITS } from '../src/presets/preset-manager.js';

const ROOT = new URL('../', import.meta.url);
const VERSION = '0.4.0';
const read = path => readFile(new URL(path, ROOT), 'utf8');

async function walk(dir = '') {
  const out = [];
  for (const entry of await readdir(new URL(dir || '.', ROOT), { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...await walk(`${path}/`));
    else out.push(path);
  }
  return out;
}

test('the service worker caches every runtime file and nothing that is missing', async () => {
  const sw = await read('sw.js');
  const assets = [...sw.matchAll(/'(\.\/[^']*)'/g)].map(m => m[1]).filter(a => a !== './');
  const files = await walk();
  const runtime = files.filter(f => /^(src|plugins|icons)\//.test(f) || ['index.html', 'styles.css', 'manifest.webmanifest'].includes(f));
  for (const file of runtime) assert.ok(assets.includes(`./${file}`), `sw.js does not cache ./${file}`);
  for (const asset of assets) assert.ok(files.includes(asset.slice(2)), `sw.js lists ${asset}, which does not exist`);
  assert.match(sw, new RegExp(`const CACHE = 'voxctl-v${VERSION.replace(/\./g, '\\.')}'`));
});

test('every id app.js binds exists in index.html', async () => {
  const [app, html] = await Promise.all([read('src/app.js'), read('index.html')]);
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const bound = [...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(bound.length > 60);
  for (const id of bound) assert.ok(ids.has(id), `index.html has no #${id}`);
});

test('the release carries one version everywhere it is shown', async () => {
  const html = await read('index.html');
  assert.match(html, new RegExp(`<title>VoxCTL v${VERSION}</title>`));
  assert.match(html, new RegExp(`class="version">v${VERSION} `));
  assert.match(await read('README.md'), new RegExp(`^# VoxCTL v${VERSION}`));
  assert.match(await read('CHANGELOG.md'), new RegExp(`## v${VERSION}`));
  assert.match(await read('src/presets/preset-manager.js'), new RegExp(`appVersion: '${VERSION}'`));
  for (const doc of (await readdir(new URL('docs/', ROOT))).filter(f => f.endsWith('.md'))) {
    const heading = (await read(`docs/${doc}`)).split('\n')[0];
    assert.ok(heading.includes(`v${VERSION}`), `docs/${doc} heading does not name v${VERSION}: ${heading}`);
  }
});

// Attributes of every <input> in index.html, by id.
async function inputs() {
  const html = await read('index.html');
  const out = {};
  for (const [tag] of html.matchAll(/<input\b[^>]*>/g)) {
    const attrs = Object.fromEntries([...tag.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (attrs.id) out[attrs.id] = attrs;
  }
  return out;
}

test('every MIDI learn target is a LEARNABLE name bound to a range input', async () => {
  const app = await read('src/app.js');
  const block = app.match(/const LEARN = \{([\s\S]*?)\n\};/)[1];
  const learn = Object.fromEntries([...block.matchAll(/^\s*(\w+): \{ el: ui\.(\w+),/gm)].map(m => [m[1], m[2]]));
  assert.deepEqual(Object.keys(learn).sort(), [...LEARNABLE].sort());
  const uiIds = Object.fromEntries([...app.matchAll(/(\w+): \$\('([^']+)'\)/g)].map(m => [m[1], m[2]]));
  const fields = await inputs();
  for (const [param, uiName] of Object.entries(learn)) {
    const id = uiIds[uiName];
    assert.ok(id, `ui.${uiName} is not bound`);
    assert.equal(fields[id]?.type, 'range', `${param} -> #${id} is not a range input`);
  }
});

test('the Feel sliders, the engine limits and the preset limits agree', async () => {
  const fields = await inputs();
  const expect = {
    referenceA4: [A4_MIN, A4_MAX], attack: DYNAMICS_LIMITS.attackMs, release: DYNAMICS_LIMITS.releaseMs,
    loudnessCurve: DYNAMICS_LIMITS.curve, freeHysteresis: [0, 25]
  };
  for (const [id, [min, max]] of Object.entries(expect)) {
    assert.deepEqual([Number(fields[id].min), Number(fields[id].max)], [min, max], id);
    assert.deepEqual(LIMITS[id].slice(0, 2), [min, max], id);
  }
});

test('the manifest names both install icons', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  const sizes = manifest.icons.map(icon => icon.sizes).sort();
  assert.deepEqual(sizes, ['192x192', '512x512']);
});

test('no em dash, en dash or curly quote anywhere in the release', async () => {
  const banned = /[\u2013\u2014\u2018\u2019\u201C\u201D]/;
  const hits = [];
  for (const file of await walk()) {
    if (/\.(png|zip)$/.test(file)) continue;
    (await read(file)).split('\n').forEach((line, i) => { if (banned.test(line)) hits.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});
