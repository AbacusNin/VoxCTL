const CACHE = 'voxctl-v0.3.2';
// Every runtime file. tests/app-shell.test.mjs fails if one is missing here,
// because an uncached module breaks offline start.
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './src/app.js',
  './src/audio/audio-engine.js', './src/audio/pitch-detector.js', './src/audio/feature-engine.js', './src/audio/calibration.js',
  './src/audio/feedback-guard.js', './src/audio/worklets/analysis-worklet.js',
  './src/mapping/scales.js', './src/mapping/mapping-engine.js', './src/mapping/pitch-tracker.js',
  './src/midi/midi-manager.js',
  './src/presets/preset-manager.js', './src/plugins/plugin-host.js',
  './plugins/ghost-radio/manifest.json', './plugins/ghost-radio/plugin.js',
  './plugins/sandbox-lfo/manifest.json', './plugins/sandbox-lfo/plugin.js'
];
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));
// Network first, cache as the offline fallback. Cache-first kept returning
// visitors on old code until every tab closed, and answered the plugin
// host's no-cache fetches from the cache anyway.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then(res => {
        // 200 only: Cache.put rejects partial (206) responses.
        if (res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
