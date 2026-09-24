const ALLOWED_CAPABILITIES = new Set([
  'synth.filter.offset',
  'synth.detune.offset',
  'fx.delay.offset',
  'fx.reverb.offset',
  'master.gain.offset'
]);

// Read permissions a plugin may request besides capabilities. Without
// voice.features.read a plugin only learns whether the voice is sounding.
const READ_PERMISSIONS = new Set(['voice.features.read']);

// master is duck-only: a plugin may lower the output but never raise it past
// the user's Output slider.
const LIMITS = {
  'synth.filter.offset': [-8000, 8000],
  'synth.detune.offset': [-2400, 2400],
  'fx.delay.offset': [-1, 1],
  'fx.reverb.offset': [-1, 1],
  'master.gain.offset': [-1, 0]
};

const PLUGIN_ID = /^[a-z0-9-]{1,40}$/;
const CONTROL_ID = /^[a-z0-9_-]{1,32}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const READY_TIMEOUT_MS = 3000;
// A legitimate plugin answers each analysis frame (about 33 per second) with
// one message per capability. Anything far above that is a flood.
export const MAX_MESSAGES_PER_SECOND = 400;
const FLUSH_MS = 16;
const MAX_LOGGED_ERRORS = 10;

// Only bundled manifests may run in the page realm. Anything else must be isolated.
const BUNDLED_TRUSTED = [new URL('../../plugins/ghost-radio/manifest.json', import.meta.url).href];

// Fixed text, so its sha256 can sit in the page CSP. The bridge is a
// MessageChannel port handed over after the frame's first load, which a
// document that later replaces the frame cannot receive.
export const SANDBOX_RUNTIME = `(() => {
  'use strict';
  let port = null;
  let instance = null;
  let ready = false;
  const send = (type, payload) => { if (port) port.postMessage({ type, ...payload }); };
  const announce = () => { if (port && instance && !ready) { ready = true; send('ready', {}); } };
  const api = Object.freeze({
    apiVersion: '0.3',
    setCapability(capability, value) { send('capability', { capability: String(capability), value: Number(value) || 0 }); }
  });
  const handle = event => {
    const data = event.data || {};
    if (!instance) return;
    try {
      if (data.type === 'signal') instance.onSignal?.(Object.freeze({ ...data.signal }));
      else if (data.type === 'parameter') instance.setParameter?.(String(data.name), data.value);
      else if (data.type === 'deactivate') { instance.deactivate?.(); instance = null; }
    } catch (error) { send('error', { message: String(error?.message || error) }); }
  };
  const onInit = event => {
    if (port || event.source !== parent || event.data?.channel !== 'voxflux-init' || !event.ports?.[0]) return;
    port = event.ports[0];
    removeEventListener('message', onInit);
    port.onmessage = handle;
    announce();
  };
  addEventListener('message', onInit);
  addEventListener('error', event => send('error', { message: String(event.message || 'sandbox error') }));
  window.voxfluxSandbox = Object.freeze({
    activate(factory) {
      if (typeof factory !== 'function') throw new Error('Sandbox plugin must call voxfluxSandbox.activate(factory).');
      instance = factory(api) || {};
      announce();
    }
  });
})();`;

// The HTML parser turns CR and CRLF into LF inside <script>, and CSP hashes
// the parsed text, so hash and insert the normalized form.
export function normalizeScript(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export async function cspHash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

// Plugins must come from this page's origin. This also rejects data:, blob:
// and javascript: URLs, whose origin never matches.
export function sameOrigin(url, base) {
  const resolved = new URL(url, base);
  if (!/^https?:$/.test(resolved.protocol) || resolved.origin !== location.origin) {
    throw new Error(`Plugin URL must be same-origin: ${resolved.href.slice(0, 120)}`);
  }
  return resolved.href;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid plugin manifest.');
  if (typeof manifest.id !== 'string' || !PLUGIN_ID.test(manifest.id)) throw new Error('Plugin id must match [a-z0-9-]{1,40}.');
  for (const [field, max] of [['name', 64], ['version', 32], ['type', 40], ['entry', 256]]) {
    const value = manifest[field];
    if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Plugin manifest ${field} must be a string of 1 to ${max} characters.`);
  }
  if (manifest.apiVersion !== '0.3') throw new Error(`Unsupported plugin API ${String(manifest.apiVersion).slice(0, 16)}.`);
  if (manifest.description !== undefined && (typeof manifest.description !== 'string' || manifest.description.length > 200)) {
    throw new Error('Plugin description must be a string of at most 200 characters.');
  }
  if (manifest.execution !== undefined && manifest.execution !== 'trusted' && manifest.execution !== 'isolated') {
    throw new Error('Plugin execution must be trusted or isolated.');
  }
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.length > 8 || permissions.some(p => typeof p !== 'string')) {
    throw new Error('Plugin permissions must be an array of at most 8 strings.');
  }
  if (new Set(permissions).size !== permissions.length) throw new Error('Plugin permissions must be unique.');
  const denied = permissions.filter(p => !ALLOWED_CAPABILITIES.has(p) && !READ_PERMISSIONS.has(p));
  if (denied.length) throw new Error(`Plugin requests unsupported permissions: ${denied.join(', ').slice(0, 200)}`);

  const ui = manifest.ui ?? [];
  if (!Array.isArray(ui) || ui.length > 24) throw new Error('Plugin ui must be an array of at most 24 controls.');
  const seen = new Set();
  ui.forEach((control, index) => {
    const where = `Plugin ui[${index}]`;
    if (!control || typeof control !== 'object' || Array.isArray(control)) throw new Error(`${where} must be an object.`);
    if (typeof control.id !== 'string' || !CONTROL_ID.test(control.id) || seen.has(control.id)) throw new Error(`${where} needs a unique id matching [a-z0-9_-]{1,32}.`);
    seen.add(control.id);
    if (typeof control.label !== 'string' || !control.label || control.label.length > 64) throw new Error(`${where} label must be a string of 1 to 64 characters.`);
    if (control.type !== 'range') throw new Error(`${where} type must be range.`);
    const { min, max, step = 1, default: value } = control;
    if (![min, max, step, value].every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${where} min, max, step and default must be finite numbers.`);
    if (!(min < max) || !(step > 0) || value < min || value > max) throw new Error(`${where} needs min < max, step > 0 and min <= default <= max.`);
  });
}

export class PluginHost {
  constructor(capabilityProvider, { trustedManifests = BUNDLED_TRUSTED, onPluginError = null } = {}) {
    this.provider = capabilityProvider;
    this.trusted = new Set(trustedManifests);
    this.onPluginError = onPluginError;
    this.plugins = new Map();
    this.contributions = new Map();
    this.loading = new Map();
    this.loadingIds = new Set();
  }

  // A second call for the same manifest while the first is in flight gets the
  // same promise, so a double click cannot create an orphaned sandbox.
  loadManifest(manifestUrl) {
    let href;
    try { href = sameOrigin(manifestUrl, document.baseURI); } catch (error) { return Promise.reject(error); }
    if (this.loading.has(href)) return this.loading.get(href);
    const promise = this.load(href).finally(() => this.loading.delete(href));
    this.loading.set(href, promise);
    return promise;
  }

  async load(manifestHref) {
    const response = await fetch(manifestHref, { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Plugin manifest HTTP ${response.status}`);
    if (response.url) sameOrigin(response.url, manifestHref);
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('Plugin manifest is too large.');
    let manifest;
    try { manifest = JSON.parse(text); } catch { throw new Error('Plugin manifest is not valid JSON.'); }
    validateManifest(manifest);
    if (this.plugins.has(manifest.id)) return this.plugins.get(manifest.id);
    if (this.loadingIds.has(manifest.id)) throw new Error(`Plugin ${manifest.id} is already loading.`);

    const execution = manifest.execution ?? 'isolated';
    if (execution === 'trusted' && !this.trusted.has(manifestHref)) throw new Error('Only bundled plugins may run trusted; declare execution "isolated".');
    const entryHref = sameOrigin(manifest.entry, manifestHref);
    const clean = { ...manifest, execution, ui: manifest.ui ?? [], description: manifest.description ?? '' };

    this.loadingIds.add(manifest.id);
    try {
      return execution === 'trusted' ? await this.loadTrusted(clean, entryHref) : await this.loadIsolated(clean, entryHref);
    } finally {
      this.loadingIds.delete(manifest.id);
    }
  }

  async loadTrusted(manifest, entryHref) {
    const mod = await this.importModule(entryHref);
    const plugin = mod.default;
    if (!plugin || typeof plugin.activate !== 'function') throw new Error('Trusted plugin entry must export default { activate(api) }.');
    if (plugin.id && plugin.id !== manifest.id) throw new Error('Plugin id does not match manifest id.');

    const record = { manifest, mode: 'trusted', live: true, instance: null };
    try {
      record.instance = await plugin.activate(this.buildApi(record));
      this.plugins.set(manifest.id, record);
      this.applyDefaults(record);
    } catch (error) {
      this.teardown(record);
      throw error;
    }
    return record;
  }

  importModule(href) { return import(href); }

  async loadIsolated(manifest, entryHref) {
    const response = await fetch(entryHref, { cache: 'no-cache', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Isolated plugin entry HTTP ${response.status}`);
    if (response.url) sameOrigin(response.url, entryHref);
    const source = normalizeScript(await response.text());
    if (source.length > MAX_SOURCE_BYTES) throw new Error('Isolated plugin source is too large.');
    // Rewriting these would change the bytes the CSP hash covers, so refuse.
    if (/<\/script|<!--/i.test(source)) throw new Error('Isolated plugin source may not contain "</script" or "<!--".');

    const hashes = `${await cspHash(SANDBOX_RUNTIME)} ${await cspHash(source)}`;
    const doc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${hashes}; base-uri 'none'; form-action 'none'"><script>${SANDBOX_RUNTIME}</script><script>${source}</script>`;

    const iframe = document.createElement('iframe');
    iframe.hidden = true;
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.title = `${manifest.name} plugin sandbox`;
    // srcdoc goes in before insertion so the frame's first load is this document.
    iframe.srcdoc = doc;

    const record = {
      manifest, mode: 'isolated', live: true, ready: false, iframe, port: null, loads: 0,
      pending: new Map(), flushTimer: 0, windowStart: 0, count: 0, errors: 0
    };

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => record.fail(new Error('Isolated plugin did not become ready.')), READY_TIMEOUT_MS);
      record.onReady = () => { clearTimeout(timer); resolve(); };
      record.fail = error => {
        clearTimeout(timer);
        if (!record.live) return;
        if (record.ready) this.evict(record, error.message);
        else { this.teardown(record); reject(error); }
      };
    });

    record.onLoad = () => {
      record.loads += 1;
      if (record.loads > 1) { record.fail(new Error(`Plugin ${manifest.id} navigated its sandbox frame and was unloaded.`)); return; }
      const channel = new MessageChannel();
      record.port = channel.port1;
      record.port.onmessage = event => this.handleIsolatedMessage(record, event.data);
      iframe.contentWindow?.postMessage({ channel: 'voxflux-init' }, '*', [channel.port2]);
    };
    iframe.addEventListener('load', record.onLoad);
    document.body.appendChild(iframe);

    await ready;
    try {
      this.plugins.set(manifest.id, record);
      this.applyDefaults(record);
    } catch (error) {
      this.teardown(record);
      throw error;
    }
    return record;
  }

  handleIsolatedMessage(record, data) {
    if (!record.live) return;
    const now = Date.now();
    if (now - record.windowStart >= 1000) { record.windowStart = now; record.count = 0; }
    if (++record.count > MAX_MESSAGES_PER_SECOND) {
      record.fail(new Error(`Plugin ${record.manifest.id} sent more than ${MAX_MESSAGES_PER_SECOND} messages per second and was unloaded.`));
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ready') {
      if (!record.ready) { record.ready = true; record.onReady(); }
    } else if (data.type === 'error') {
      if (++record.errors <= MAX_LOGGED_ERRORS) console.warn(`Plugin ${record.manifest.id} sandbox error:`, String(data.message).slice(0, 200));
    } else if (data.type === 'capability' && record.ready) {
      // Before ready the load can still fail, and nothing would clear the offset.
      const { capability, value } = data;
      if (typeof capability !== 'string' || !record.manifest.permissions.includes(capability) || !ALLOWED_CAPABILITIES.has(capability)) return;
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      // Keep only the latest value and apply it once per flush, so a burst
      // does not turn into a burst of AudioParam automation events.
      record.pending.set(capability, value);
      if (!record.flushTimer) record.flushTimer = setTimeout(() => this.flush(record), FLUSH_MS);
    }
  }

  flush(record) {
    record.flushTimer = 0;
    if (!record.live) return;
    for (const [capability, value] of record.pending) this.setContribution(record.manifest.id, capability, value);
    record.pending.clear();
  }

  buildApi(record) {
    const { id, permissions } = record.manifest;
    const granted = new Set(permissions);
    // A trusted plugin that keeps a reference after unload or a failed
    // activate must not be able to move the synth again.
    const offset = capability => Object.freeze({
      setOffset: value => { if (record.live) this.setContribution(id, capability, value); }
    });
    const api = { apiVersion: '0.3' };
    if (granted.has('synth.filter.offset')) api.filter = offset('synth.filter.offset');
    if (granted.has('synth.detune.offset')) api.detune = offset('synth.detune.offset');
    if (granted.has('fx.delay.offset')) api.delay = offset('fx.delay.offset');
    if (granted.has('fx.reverb.offset')) api.reverb = offset('fx.reverb.offset');
    if (granted.has('master.gain.offset')) api.master = offset('master.gain.offset');
    return Object.freeze(api);
  }

  setContribution(pluginId, capability, value) {
    if (!ALLOWED_CAPABILITIES.has(capability)) return;
    if (!this.contributions.has(pluginId)) this.contributions.set(pluginId, new Map());
    const [min, max] = LIMITS[capability];
    this.contributions.get(pluginId).set(capability, clamp(value, min, max));
    this.recomputeCapability(capability);
  }

  recomputeCapability(capability) {
    let total = 0;
    for (const contributions of this.contributions.values()) total += Number(contributions.get(capability)) || 0;
    const [min, max] = LIMITS[capability];
    total = clamp(total, min, max);
    if (capability === 'synth.filter.offset') this.provider.setFilterOffset(total);
    else if (capability === 'synth.detune.offset') this.provider.setDetuneOffset(total);
    else if (capability === 'fx.delay.offset') this.provider.setDelayOffset(total);
    else if (capability === 'fx.reverb.offset') this.provider.setReverbOffset(total);
    else if (capability === 'master.gain.offset') this.provider.setMasterOffset(total);
  }

  list() { return [...this.plugins.values()]; }

  // Values come from UI controls, but plugins trust them, so hold them to the
  // manifest's own control definition.
  setParameter(id, name, value) {
    const record = this.plugins.get(id);
    if (!record) return;
    const control = record.manifest.ui.find(c => c.id === name);
    const n = Number(value);
    if (!control || !Number.isFinite(n)) return;
    const clean = clamp(n, control.min, control.max);
    if (record.mode === 'isolated') this.post(record, { type: 'parameter', name: control.id, value: clean });
    else record.instance?.setParameter?.(control.id, clean);
  }

  applyDefaults(record) {
    for (const control of record.manifest.ui) this.setParameter(record.manifest.id, control.id, control.default);
  }

  notifySignal(signal) {
    for (const record of this.plugins.values()) {
      const payload = signalFor(record.manifest, signal);
      try {
        if (record.mode === 'isolated') this.post(record, { type: 'signal', signal: payload });
        else record.instance?.onSignal?.(payload);
      } catch (error) { console.warn(`Plugin ${record.manifest.id} signal error`, error); }
    }
  }

  post(record, payload) {
    if (record.live && record.ready) record.port?.postMessage(payload);
  }

  deactivate(id) {
    const record = this.plugins.get(id);
    if (!record) return;
    try {
      if (record.mode === 'isolated') this.post(record, { type: 'deactivate' });
      else record.instance?.deactivate?.();
    } catch (error) {
      console.warn(`Plugin ${id} deactivate error`, error);
    } finally {
      this.teardown(record);
    }
  }

  evict(record, reason) {
    this.teardown(record);
    console.warn(reason);
    this.onPluginError?.(record.manifest.id, reason);
  }

  // Stops the plugin from reaching the synth again and removes every offset it set.
  teardown(record) {
    record.live = false;
    if (record.flushTimer) clearTimeout(record.flushTimer);
    record.flushTimer = 0;
    record.pending?.clear();
    if (record.port) { record.port.onmessage = null; record.port.close(); }
    if (record.iframe) {
      record.iframe.removeEventListener('load', record.onLoad);
      record.iframe.remove();
    }
    const id = record.manifest.id;
    if (this.plugins.get(id) === record) this.plugins.delete(id);
    const affected = [...(this.contributions.get(id)?.keys() || [])];
    this.contributions.delete(id);
    affected.forEach(capability => this.recomputeCapability(capability));
  }
}

// Only numbers and booleans cross the boundary, and only voiced unless the
// manifest asked to read the voice features.
function signalFor(manifest, signal) {
  const out = { voiced: Boolean(signal?.voiced) };
  if (manifest.permissions.includes('voice.features.read')) {
    for (const [key, value] of Object.entries(signal || {})) {
      if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') out[key] = value;
    }
  }
  return Object.freeze(out);
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
