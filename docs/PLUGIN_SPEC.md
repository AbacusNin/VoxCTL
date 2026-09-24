# Plugin Specification, API v0.3 (app v0.3.2)

The plugin API version stays 0.3. The v0.3.1 release tightened what the host accepts; those rules are below.

## Manifest

```json
{
  "id": "example",
  "name": "Example",
  "version": "0.3.2",
  "type": "controller",
  "apiVersion": "0.3",
  "execution": "isolated",
  "entry": "./plugin.js",
  "description": "Example plugin",
  "permissions": ["synth.filter.offset"],
  "ui": [
    {"id":"depth","label":"Depth","type":"range","min":0,"max":3000,"step":50,"default":1200}
  ]
}
```

The host rejects a manifest unless:

- it is a JSON object of at most 64 KB, fetched from the page's own origin over http or https;
- `id` matches `[a-z0-9-]{1,40}`;
- `name` (up to 64 characters), `version` (32), `type` (40) and `entry` (256) are non-empty strings;
- `apiVersion` is `"0.3"`;
- `description`, if present, is a string of at most 200 characters;
- `execution`, if present, is `"trusted"` or `"isolated"`; a missing field means isolated;
- `permissions` is an array of at most 8 unique strings, each from the lists below;
- `ui` is an array of at most 24 controls, each valid as described under Manifest UI.

The entry URL is resolved against the manifest URL and must also be same-origin. Data URLs, blob URLs and cross-origin URLs are refused.

## Permissions

Capabilities a plugin may write:

- synth.filter.offset, clamped to -8000 to 8000 Hz
- synth.detune.offset, clamped to -2400 to 2400 cents
- fx.delay.offset, clamped to -1 to 1
- fx.reverb.offset, clamped to -1 to 1
- master.gain.offset, clamped to -1 to 0: a plugin may lower the output but never raise it past the user's Output slider

Read permission:

- voice.features.read: the plugin receives every finite number and boolean in the voice signal (pitch, level, spectral features, vibrato). Without it, a plugin's signal is only `{ voiced }`.

Contributions are tracked per plugin, summed and clamped by the host, so unloading one plugin removes only that plugin's contribution.

## Trusted plugin contract

Only manifests on the host's allowlist may run trusted. In this release that is the bundled Ghost Radio manifest in plugins/ghost-radio. A trusted plugin is an ES module that exports:

```js
export default {
  id: 'example',
  async activate(api) {
    return {
      onSignal(signal) {},
      setParameter(name, value) {},
      deactivate() {}
    };
  }
};
```

The `api` contains only the declared capability handles, for example `api.filter.setOffset(value)`. A handle stops working once the plugin is unloaded or if `activate` throws, and a failed activation removes any offset it set. Trusted plugins are application-trusted, because ES modules execute in the page realm.

## Isolated plugin contract

Isolated plugin entries are ordinary scripts, not ES modules. They call the sandbox bootstrap:

```js
voxctlSandbox.activate(api => ({
  onSignal(signal) {
    api.setCapability('synth.filter.offset', 500);
  },
  setParameter(name, value) {},
  deactivate() {
    api.setCapability('synth.filter.offset', 0);
  }
}));
```

The plugin does not receive host objects. `api.setCapability()` posts a message over a private MessageChannel port. The host checks it against the manifest permissions and the host allowlist, drops non-finite values, and applies the latest value per capability once every 16 ms. Capability messages sent before the plugin reports ready are ignored.

The source must not contain a closing script tag or an HTML comment opener, because rewriting either would change the bytes the CSP hash covers.

## Isolated execution controls

- The iframe has only `sandbox="allow-scripts"`. It omits `allow-same-origin`, so its origin is opaque and it cannot reach the app's DOM, storage or cookies.
- Its document is built from a fixed runtime script plus the plugin source, each in its own script block. The frame's own CSP is `default-src 'none'` with script-src limited to those two hashes. The frame also inherits the page CSP, whose script-src must list both hashes. The CSP hash test in the tests folder prints the hashes and fails if the page CSP is out of date. In practice only bundled isolated plugins can run.
- The host hands the frame a MessageChannel port on the frame's first load. The runtime accepts it only from the parent window. A document that later replaces the frame cannot receive the port, and any second load of the frame unloads the plugin.
- A plugin that does not report ready within 3 s fails to load, and any offsets are cleared.
- A plugin that sends more than 400 messages in a second is unloaded. Its error messages are cut to 200 characters, and at most 10 are logged.

This model suits control and modulation plugins. It is not an architecture for third-party audio DSP.

## Manifest UI

The host renders plugin controls itself; plugin code receives only `setParameter` calls. The only control type is `range`. Each control must have:

- a unique `id` matching `[a-z0-9_-]{1,32}`,
- a `label` of 1 to 64 characters,
- finite numeric `min` < `max`,
- a finite `step` > 0 (optional, default 1),
- a finite `default` within `[min, max]`.

Any other shape fails the load. `setParameter` values are clamped to the control's range, and names that are not in the manifest are ignored.
