import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { SANDBOX_RUNTIME, cspHash, normalizeScript } from '../src/plugins/plugin-host.js';

const ROOT = new URL('../', import.meta.url);

// The sandbox srcdoc inherits the page CSP, so every inline script it runs
// must be hashed there. This fails when the runtime or a bundled isolated
// plugin changes and index.html was not updated.
async function requiredHashes() {
  const hashes = [await cspHash(SANDBOX_RUNTIME)];
  for (const dir of (await readdir(new URL('plugins/', ROOT))).sort()) {
    const manifest = JSON.parse(await readFile(new URL(`plugins/${dir}/manifest.json`, ROOT), 'utf8'));
    if ((manifest.execution ?? 'isolated') !== 'isolated') continue;
    const source = await readFile(new URL(`plugins/${dir}/${manifest.entry}`, ROOT), 'utf8');
    hashes.push(await cspHash(normalizeScript(source)));
  }
  return hashes;
}

function directives(csp) {
  return Object.fromEntries(csp.split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([name, ...values]) => [name, values]));
}

test('page CSP lists the sandbox runtime and every bundled isolated plugin', async t => {
  const html = await readFile(new URL('index.html', ROOT), 'utf8');
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  const hashes = await requiredHashes();
  if (!match) {
    t.skip(`index.html has no CSP yet; script-src needs 'self' ${hashes.join(' ')}`);
    return;
  }
  const policy = directives(match[1]);
  const scriptSrc = policy['script-src'] || policy['default-src'] || [];
  for (const hash of hashes) assert.ok(scriptSrc.includes(hash), `script-src is missing ${hash}`);
  assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), 'script-src must not allow unsafe-inline or unsafe-eval');
  assert.ok((policy['media-src'] || []).includes('blob:'), 'media-src needs blob: for recording playback');
});
