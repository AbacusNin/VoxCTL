// Static checks on the shipped files: the offline cache, the element ids the
// app binds, the release version, and the publishing rules for text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const VERSION = '0.3.1';
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
  assert.match(sw, new RegExp(`const CACHE = 'voxflux-v${VERSION.replace(/\./g, '\\.')}'`));
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
  assert.match(html, new RegExp(`<title>VoxFlux v${VERSION}</title>`));
  assert.match(html, new RegExp(`class="version">v${VERSION} `));
  assert.match(await read('README.md'), new RegExp(`^# VoxFlux v${VERSION}`));
  assert.match(await read('CHANGELOG.md'), new RegExp(`## v${VERSION}`));
  assert.match(await read('src/presets/preset-manager.js'), new RegExp(`appVersion: '${VERSION}'`));
  for (const doc of (await readdir(new URL('docs/', ROOT))).filter(f => f.endsWith('.md'))) {
    const heading = (await read(`docs/${doc}`)).split('\n')[0];
    assert.ok(heading.includes(`v${VERSION}`), `docs/${doc} heading does not name v${VERSION}: ${heading}`);
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
