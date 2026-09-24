# Build Validation, v0.3.1

These are the checks run on this release, with their results. Anything not listed here was not tested.

## Automated

Run from the repository root; no packages are needed. The results below are from Node 24.

- node --check on every .js and .mjs file: all pass.
- node --test tests/*.test.mjs: 95 tests, all pass.

The suite covers:

- Pitch accuracy: 12 pitches from 72 to 1100 Hz, each with a full and a 15% fundamental, at noise levels 0, 0.005 and 0.02, 3 seeds each, at 16, 44.1, 48 and 96 kHz. Every voiced reading is within 20 cents. Tones above 1400 Hz and below 65 Hz read unvoiced.
- The worklet posts whole windows by transfer, contains no analysis code, and its windows give the right pitch through the shared detector.
- Glide and quantizing: the median, sticky quantizing (a voice at 60.5 ±3 cents flips at most once in 100 frames, chromatic and 24-EDO), the jump after silence, and custom-scale parsing.
- The feedback guard, calibration with storage blocked, vibrato on a melody, a glide, and vibrato riding on a glide.
- The audio graph (limiter before destination, recorder after it), the concurrent start guard, MIDI output message order, note holding and CC11, and MIDI input note order.
- The plugin host: same-origin rules, the trusted allowlist, manifest validation, message coalescing and flood eviction, double loads, and cleanup after failed loads.
- Presets: sanitizing on read, allowlists, id collisions, the import size cap, and prototype keys.
- The page CSP lists the current sha256 of the sandbox runtime and the bundled isolated plugin, with no unsafe-inline and with blob: media.
- The app itself, loaded against a DOM and Web Audio shim: boot state, Record before Start, a double click on Start, worklet windows reaching the synth, the feedback guard end to end, the visibility suspend, MIDI override on key arrival, fatal speech errors, speech results from resultIndex, calibration with storage blocked, the preset size cap, plugin load errors, and a recorder error mid-take.
- The shipped files: the service worker caches every runtime file and nothing missing, every element id app.js binds exists, the version is 0.3.1 wherever it is shown, the manifest lists both icons, and no em dash, en dash or curly quote appears anywhere.

## Manual, in Chromium, served from a local static server

- The page loaded under its CSP with no violations, and the pre-flight check read INSTRUMENT READY.
- Sandbox LFO (isolated) and Ghost Radio (trusted) both loaded and rendered their controls. Unload removed the sandbox iframe.
- A blob: URL played in the recording player without a CSP violation.
- A cross-origin iframe, and a sandboxed frame redirecting itself to another origin, were both blocked by frame-src.
- At a 375 px wide viewport with DPR 2, the scope canvas backing store was 682 by 560 for a 341 by 280 box, and the page had no horizontal scroll.
- The service worker registered, activated and filled the voxflux-v0.3.1 cache.
- With a synthetic harmonic tone standing in for the microphone, the worklet path read 110, 147, 262, 330, 660, 880 and 1100 Hz correctly on the display and at the synth oscillator.
- Loading the sandboxed plugin twice in quick succession created one iframe, and the page could not read into the frame.
- A recorded take played under the page CSP and reported its real duration. Hiding the tab suspended audio when idle and kept it running while recording.
- A simulated speaker loop, where the input sounded only while the synth did, tripped the feedback guard about 190 ms into its first probe and left the synth muted.

## Not tested

- No physical microphone, speakers, MIDI device or speech service was used. Pitch tracking, the feedback guard and the visibility suspend were exercised only with synthetic signals. Offline reload after the first visit was not tried.
