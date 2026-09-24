import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { PluginHost, SANDBOX_RUNTIME, MAX_MESSAGES_PER_SECOND, validateManifest } from '../src/plugins/plugin-host.js';

const ORIGIN = 'https://example.test';
const ROOT = new URL('../', import.meta.url);
const GHOST = `${ORIGIN}/plugins/ghost-radio/manifest.json`;

let files, frames, provider, fetched, openPorts;

function makeFrame() {
  const listeners = new Map();
  const frame = {
    removed: false, init: null,
    setAttribute(name, value) { this[name] = value; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    remove() { this.removed = true; },
    fireLoad() { listeners.get('load')?.(); },
    contentWindow: {
      postMessage(data, target, transfer) {
        frame.init = { data, target, port: transfer?.[0] };
        if (transfer?.[0]) openPorts.push(transfer[0]);
      }
    }
  };
  return frame;
}

beforeEach(() => {
  files = new Map();
  frames = [];
  fetched = [];
  openPorts = [];
  provider = { calls: 0, values: {} };
  for (const name of ['setFilterOffset', 'setDetuneOffset', 'setDelayOffset', 'setReverbOffset', 'setMasterOffset']) {
    provider[name] = value => { provider.calls++; provider.values[name] = value; };
  }
  globalThis.location = { origin: ORIGIN };
  globalThis.document = {
    baseURI: `${ORIGIN}/`,
    body: { appendChild() {} },
    createElement() { const f = makeFrame(); frames.push(f); return f; }
  };
  globalThis.fetch = async href => {
    fetched.push(href);
    const url = new URL(href);
    let body = files.get(href);
    if (body === undefined && url.origin === ORIGIN) {
      try { body = await readFile(new URL(`.${url.pathname}`, ROOT), 'utf8'); } catch { body = null; }
    }
    return { ok: body !== null, status: body === null ? 404 : 200, url: href, text: async () => body };
  };
});

afterEach(() => {
  openPorts.forEach(p => p.close());
  delete globalThis.location;
  delete globalThis.document;
  delete globalThis.fetch;
});

function newHost(options = {}) {
  const host = new PluginHost(provider, { trustedManifests: [GHOST], ...options });
  // Node cannot import https URLs; map them onto the files in this package.
  host.importModule = href => import(new URL(`.${new URL(href).pathname}`, ROOT).href);
  return host;
}

const manifest = (extra = {}) => JSON.stringify({
  id: 'x', name: 'X', version: '1', type: 'controller', apiVersion: '0.3', execution: 'isolated',
  entry: './p.js', permissions: ['synth.filter.offset'], ui: [], ...extra
});

// Runs the real sandbox runtime and plugin source in a separate realm, the way
// the srcdoc frame would, and returns the frame's side of the port.
function bootSandbox(frame, source) {
  const listeners = [];
  const parent = {};
  const ctx = vm.createContext({
    parent,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
  });
  ctx.window = ctx;
  vm.runInContext(SANDBOX_RUNTIME, ctx);
  vm.runInContext(source, ctx);
  frame.fireLoad();
  const { data, port } = frame.init;
  [...listeners].forEach(fn => fn({ source: parent, data, ports: [port] }));
  return ctx;
}

const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(check) { for (let i = 0; i < 200 && !check(); i++) await tick(5); assert.ok(check(), 'condition never became true'); }

test('bundled manifests validate', async () => {
  for (const path of ['plugins/ghost-radio/manifest.json', 'plugins/sandbox-lfo/manifest.json']) {
    validateManifest(JSON.parse(await readFile(new URL(path, ROOT), 'utf8')));
  }
});

test('manifest and entry URLs must be same-origin http(s)', async () => {
  const host = newHost();
  await assert.rejects(host.loadManifest('https://evil.example/m.json'), /same-origin/);
  await assert.rejects(host.loadManifest('data:application/json,{}'), /same-origin/);
  files.set(`${ORIGIN}/m1.json`, manifest({ entry: 'https://evil.example/p.js' }));
  await assert.rejects(host.loadManifest('./m1.json'), /same-origin/);
  files.set(`${ORIGIN}/m2.json`, manifest({ entry: 'data:text/javascript,globalThis.PWNED=1' }));
  await assert.rejects(host.loadManifest('./m2.json'), /same-origin/);
  assert.equal(globalThis.PWNED, undefined);
  assert.ok(fetched.every(href => href.startsWith(ORIGIN)));
});

test('trusted execution is limited to the bundled allowlist; a missing execution field is isolated', async () => {
  const host = newHost();
  files.set(`${ORIGIN}/t.json`, manifest({ execution: 'trusted' }));
  await assert.rejects(host.loadManifest('./t.json'), /Only bundled plugins may run trusted/);
  files.set(`${ORIGIN}/n.json`, manifest({ execution: undefined }));
  files.set(`${ORIGIN}/p.js`, 'voxfluxSandbox.activate(() => ({}));');
  const pending = host.loadManifest('./n.json');
  await until(() => frames[0]);
  assert.equal(frames.length, 1, 'no execution field went to the sandbox');
  bootSandbox(frames[0], files.get(`${ORIGIN}/p.js`));
  const record = await pending;
  assert.equal(record.mode, 'isolated');
  host.deactivate('x');
});

test('malformed manifests are rejected before anything runs', () => {
  const base = JSON.parse(manifest());
  const range = { id: 'depth', label: 'Depth', type: 'range', min: 0, max: 10, step: 1, default: 5 };
  const bad = [
    { ui: [null] },
    { ui: [{ ...range, label: undefined }] },
    { ui: [{ ...range, type: 'checkbox' }] },
    { ui: [{ ...range, default: 11 }] },
    { ui: [{ ...range, min: 10, max: 0 }] },
    { ui: [{ ...range, step: 0 }] },
    { ui: [{ ...range, max: '10' }] },
    { ui: [range, range] },
    { ui: [{ ...range, id: '"><img>' }] },
    { id: '../evil' },
    { id: 'x'.repeat(41) },
    { name: 'n'.repeat(65) },
    { description: 'd'.repeat(201) },
    { description: 7 },
    { permissions: ['synth.filter.offset', 'synth.filter.offset'] },
    { permissions: ['mic.raw'] },
    { permissions: [1] },
    { execution: 'page' },
    { apiVersion: '0.2' }
  ];
  for (const patch of bad) assert.throws(() => validateManifest({ ...base, ...patch }), Error, JSON.stringify(patch).slice(0, 80));
  validateManifest({ ...base, ui: [range] });
});

test('sandbox LFO boots over the port, drives only its permission, and ignores a replaced document', async () => {
  const host = newHost();
  const pending = host.loadManifest('./plugins/sandbox-lfo/manifest.json');
  await until(() => frames[0]);
  const frame = frames[0];
  assert.equal(frame.sandbox, 'allow-scripts');
  assert.match(frame.srcdoc, /script-src 'sha256-[A-Za-z0-9+/=]+' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(frame.srcdoc, /unsafe-inline|navigate-to/);
  assert.ok(frame.srcdoc.includes(`<script>${SANDBOX_RUNTIME}</script>`));
  const source = await readFile(new URL('plugins/sandbox-lfo/plugin.js', ROOT), 'utf8');
  bootSandbox(frame, source);
  const record = await pending;
  assert.equal(record.mode, 'isolated');

  host.notifySignal({ voiced: true, pitchHz: 220, formant1: 700 });
  await tick(40);
  assert.ok(Math.abs(provider.values.setFilterOffset) > 0, 'LFO moved the filter');

  frame.fireLoad();
  assert.equal(frame.removed, true, 'a second load tears the plugin down');
  assert.equal(host.list().length, 0);
  assert.equal(provider.values.setFilterOffset, 0, 'its offset was cleared');
});

test('signals carry only voiced unless voice.features.read is granted', async () => {
  const host = newHost();
  files.set(`${ORIGIN}/m.json`, manifest());
  files.set(`${ORIGIN}/p.js`, 'voxfluxSandbox.activate(() => ({}));');
  const pending = host.loadManifest('./m.json');
  await until(() => frames[0]);
  frames[0].fireLoad();
  const port = frames[0].init.port;
  const got = [];
  port.onmessage = e => got.push(e.data);
  port.postMessage({ type: 'ready' });
  await pending;
  host.notifySignal({ voiced: true, pitchHz: 220, formant1: 700, nested: { a: 1 } });
  await tick(5);
  assert.deepEqual(got.find(m => m.type === 'signal').signal, { voiced: true });

  const ghost = newHost();
  const trusted = await ghost.loadManifest('./plugins/ghost-radio/manifest.json');
  const seen = [];
  trusted.instance.onSignal = s => seen.push(s);
  ghost.notifySignal({ voiced: true, brightness: 0.4, nested: { a: 1 }, label: 'x' });
  assert.deepEqual(seen[0], { voiced: true, brightness: 0.4 });
  ghost.deactivate('ghost-radio');
});

test('capabilities sent before ready are dropped and a failed load leaves no offset', async () => {
  const host = newHost();
  files.set(`${ORIGIN}/m.json`, manifest());
  files.set(`${ORIGIN}/p.js`, '');
  const pending = host.loadManifest('./m.json');
  await until(() => frames[0]);
  frames[0].fireLoad();
  frames[0].init.port.postMessage({ type: 'capability', capability: 'synth.filter.offset', value: 8000 });
  await tick(40);
  assert.equal(provider.calls, 0);
  frames[0].fireLoad();
  await assert.rejects(pending, /navigated/);
  assert.equal(frames[0].removed, true);
  assert.equal(host.contributions.size, 0);
});

test('a trusted plugin that throws in activate leaves no offset and cannot act later', async () => {
  const host = newHost();
  let saved;
  host.importModule = async () => ({ default: { activate(api) { saved = api; api.filter.setOffset(5000); throw new Error('boom'); } } });
  await assert.rejects(host.loadManifest('./plugins/ghost-radio/manifest.json'), /boom/);
  assert.equal(provider.values.setFilterOffset, 0);
  saved.filter.setOffset(4000);
  assert.equal(provider.values.setFilterOffset, 0);
  assert.equal(host.list().length, 0);
});

test('a double click shares one load and one sandbox', async () => {
  const host = newHost();
  const a = host.loadManifest('./plugins/sandbox-lfo/manifest.json');
  const b = host.loadManifest('./plugins/sandbox-lfo/manifest.json');
  assert.equal(a, b);
  await until(() => frames[0]);
  await tick(5);
  assert.equal(frames.length, 1);
  bootSandbox(frames[0], await readFile(new URL('plugins/sandbox-lfo/plugin.js', ROOT), 'utf8'));
  await a;
  host.deactivate('sandbox-lfo');
  assert.equal(frames[0].removed, true);
});

test('bursts are coalesced and a flood unloads the plugin', async () => {
  const errors = [];
  const host = newHost({ onPluginError: (id, reason) => errors.push([id, reason]) });
  files.set(`${ORIGIN}/m.json`, manifest({ permissions: ['synth.filter.offset', 'master.gain.offset'] }));
  files.set(`${ORIGIN}/p.js`, '');
  const pending = host.loadManifest('./m.json');
  await until(() => frames[0]);
  frames[0].fireLoad();
  const port = frames[0].init.port;
  port.postMessage({ type: 'ready' });
  await pending;

  for (let i = 0; i < 100; i++) port.postMessage({ type: 'capability', capability: 'synth.filter.offset', value: i });
  port.postMessage({ type: 'capability', capability: 'master.gain.offset', value: 1 });
  port.postMessage({ type: 'capability', capability: 'fx.delay.offset', value: 1 });
  await tick(40);
  assert.ok(provider.calls <= 4, `coalesced to ${provider.calls} provider calls`);
  assert.equal(provider.values.setFilterOffset, 99);
  assert.equal(provider.values.setMasterOffset, 0, 'master offset cannot rise above the slider');
  assert.equal(provider.values.setDelayOffset, undefined, 'ungranted capability ignored');

  for (let i = 0; i < MAX_MESSAGES_PER_SECOND + 50; i++) port.postMessage({ type: 'error', message: 'e'.repeat(5000) });
  await tick(40);
  assert.equal(host.list().length, 0);
  assert.equal(errors[0][0], 'x');
  assert.equal(provider.values.setFilterOffset, 0);
});

test('UI parameters are clamped to the control definition and unknown names dropped', async () => {
  const host = newHost();
  const record = await host.loadManifest('./plugins/ghost-radio/manifest.json');
  const got = [];
  record.instance.setParameter = (name, value) => got.push([name, value]);
  host.setParameter('ghost-radio', 'depth', 1e9);
  host.setParameter('ghost-radio', 'depth', 'NaN');
  host.setParameter('ghost-radio', '__proto__', 1);
  host.setParameter('ghost-radio', 'rate', -5);
  assert.deepEqual(got, [['depth', 2200], ['rate', 0.005]]);
  host.deactivate('ghost-radio');
});

test('sources that could break out of the script block are refused', async () => {
  const host = newHost();
  files.set(`${ORIGIN}/m.json`, manifest());
  files.set(`${ORIGIN}/p.js`, 'const s = "</script><script>alert(1)</script>";');
  await assert.rejects(host.loadManifest('./m.json'), /may not contain/);
  assert.equal(frames.length, 0);
});
