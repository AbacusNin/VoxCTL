# Build Validation, v0.4.0

These are the checks run on this release, with their results. Anything not listed here was not tested.

## Automated

Run from the repository root; no packages are needed. The results below are from Node 24.

- node --check on every .js and .mjs file: all pass.
- node --test tests/*.test.mjs: 194 tests, all pass (95 in v0.3.2).
- The standards scanner on the repository: no blocking findings.

The suite covers:

- Pitch accuracy: 12 pitches from 72 to 1100 Hz, each with a full and a 15% fundamental, at noise levels 0, 0.005 and 0.02, 3 seeds each, at 16, 44.1, 48 and 96 kHz. Every voiced reading is within 20 cents. Tones above 1400 Hz and below 65 Hz read unvoiced.
- The worklet posts whole windows by transfer, contains no analysis code, and its windows give the right pitch through the shared detector.
- Glide and quantizing: the median, sticky quantizing (a voice at 60.5 ±3 cents flips at most once in 100 frames, chromatic and 24-EDO), the jump after silence, and custom-scale parsing.
- The feedback guard, calibration with storage blocked, vibrato on a melody, a glide, and vibrato riding on a glide.
- The audio graph (limiter before destination, the recorder on its twin limiter), the concurrent start guard, MIDI output message order, note holding and CC11, and MIDI input note order.
- The plugin host: same-origin rules, the trusted allowlist, manifest validation, message coalescing and flood eviction, double loads, and cleanup after failed loads.
- Presets: sanitizing on read, allowlists, id collisions, the import size cap, and prototype keys.
- The page CSP lists the current sha256 of the sandbox runtime and the bundled isolated plugin, with no unsafe-inline and with blob: media.
- The app itself, loaded against a DOM, Web Audio and Web MIDI shim whose audio clock follows a fake performance clock: boot state, Record before Start, a double click on Start, worklet windows reaching the synth, the feedback guard end to end, the visibility suspend, MIDI override on key arrival, fatal speech errors, speech results from resultIndex, calibration with storage blocked, the preset size cap, plugin load errors, and a recorder error mid-take.
- The shipped files: the service worker caches every runtime file and nothing missing, every element id app.js binds exists, the version is 0.4.0 wherever it is shown, the manifest lists both icons, and no em dash, en dash or curly quote appears anywhere.

Added in v0.4.0:

- A4 reference: conversions and custom cents scales in reference space, the cents offset stays within half a semitone, blank or junk input means 440, the engine moves only the oscillator base, a reference set before Start is built into the graph, and vibrato estimates do not change with the base pitch or the reference.
- PitchTracker: a reference change shifts the median and the free-mode hold instead of resetting, a reference swept every frame never reports a jump, and the quantized note stays. Free-mode hysteresis is off by default so vibrato passes; when on, it removes shallow vibrato but lets a semitone step through, holds a steady offset (+13 cents held at 14), stairs a 100 cent per second glide, and is ignored in quantized mode. A 220 to 440 Hz octave leap is followed.
- Dynamics: attack or release is chosen against the modeled gain (after 0.8 then 0.2, a target of 0.5 is still a fall), limits clamp, and mute() uses the 35 ms constant whatever the release and schedules nothing more while in force. The real FeedbackGuard against a simulated 250 ms speaker delay trips with the 35 ms mute and not with a 2 s release.
- Latency: every part, unreported browser values marked instead of counted as 0, junk values, the capped cadence, and the round trip used for take alignment.
- Looper: bar and beat arithmetic, loop fitting and its refusals, tempo clamping, the click (20 ms, reads unvoiced alone; a quiet click moves a sung note 8 cents or less), the count-in clicking with the metronome off, the recorder start at the pre-roll and the auto-stop, the latency compensation, every cancel path, stalls dropping past beats, node pruning, stopAll, the hidden-tab rule, loop start and swap timing, trim versus rate fit, early stops, and the decode cap. The audio graph test walks it: loop and click reach the heard limiter only, and only master reaches the recorder.
- MIDI: CC 120 and 123 release held keys, and a 128-step A4 sweep under a held voice sends one note-on and then only bends. MIDI learn validation (hostile arrays, prototype names, the 64-entry scan and 32 cap, one binding per CC and per param, blocked storage, oversized text), CC to slider snapping, and the plugin id rules matching the plugin host.
- Presets: schema 2 export, round trips of every factory preset and of a user preset with tempo and bindings, schema 1 imports with v1 fields only, clamping and step snapping of the new fields, hostile values, newer and junk schema versions, stored 0.3.2 records read with fallbacks and never rewritten, binding validation inside presets, and every preset limit matching its control in index.html.
- The app, against the shim: the looper before Start, stored bindings validated at boot and kept through every factory preset, a prototype-name binding and an unloaded-plugin binding doing nothing, learn and apply through the slider's input event, 50 CCs coalescing into one event, a panic CC not binding, the 15 s learn timeout, CCs no longer muting the voice or retriggering MIDI out under override, the reference retuning quantized notes and the tuner without retriggering MIDI out, a reference change under MIDI override, the tuner before hysteresis and under the gate, a 2 s release at note end with calibration and the guard probe still muting at 35 ms, the latency panel, a full grid take from count-in to loop, the hidden tab stopping the loop, five ways to cancel a count-in, the speech command refused during a count-in and the canceled count-in stopping the clicks it started, a stop in the pre-roll, tempo clamping and locking, the decode cap, and presets carrying bindings only through the toggle.
- Static checks: every MIDI learn target is a LEARNABLE name bound to a range input, and the Feel sliders, engine limits and preset limits agree.

Each of these tests was checked to fail with the behavior it guards reverted, where that was practical: the guard branch switched from mute() to release(), the CC branch allowed to fall through to the override tail, the count-in rewind removed, the count-in cancel left clicking, the speech record guard removed, and the direction logic taken from the last target instead of the modeled gain.

## Measured during v0.4.0 design, in Chromium with OfflineAudioContext and MediaRecorder

These were measured while designing the release, to decide what to port. They are not part of the automated suite.

- A later setTargetAtTime supersedes a running long one: a 35 ms mute after a 0.667 s ramp gave 0.0395 at +100 ms with or without a cancel, against 0.593 for the long ramp alone.
- The engine's gain model matched 120 mixed setTargetAtTime events to 1e-4.
- Each DynamicsCompressorNode delayed an impulse by 6 ms. The twin record limiter gave the same peak as the heard one (0.926 for a +5 dBFS input).
- A take offset read just before MediaRecorder.start() was 6.5 to 14.5 ms off over 6 trials; one read in onstart was 67.9 to 75.9 ms off.

## Why some v0.4 prototype features were not ported

Run against the v0.4 prototype's code:

- Its octave guard held a sung 220 to 440 Hz leap at 220 Hz for all 1.8 s.
- Its 14 cent free-mode hysteresis default turned a ±10 cent vibrato into one flat pitch, and a 100 cent per second glide into 15 cent stairs.
- Its mute used the release time; with the real FeedbackGuard, a 250 ms speaker delay went uncaught from a 300 ms release up.

## Manual, in Chromium, served from a local static server (v0.4.0)

A synthetic harmonic tone stood in for the microphone, and the audio graph was instrumented from the console.

- The page loaded under its CSP with no violations or console errors. The pre-flight check read INSTRUMENT READY, and the service worker filled the voxctl-v0.4.0 cache.
- **The first browser run found a bug every Node test had missed.** LoopEngine stored the browser's setInterval and called it as a method, so the browser threw "Illegal invocation" and the metronome, count-in and loop timer never ran, while the button read "Stop tempo". Node does not enforce that rule. The defaults are now plain calls, and a test reproduces the browser's rule.
- Reference A4: singing 440 Hz, the tuner read +32 cents against 432 and -39 cents against 450 (expected +31.8 and -38.9). Free mode kept playing 440 Hz; quantized chromatic mode played 450 Hz at a 450 reference.
- Metronome at 120 BPM: clicks exactly 0.500 s apart on the audio clock, each scheduled 0.1 s ahead. Hiding the tab stopped them, and they stayed stopped on return.
- Clicks never reach a take. With the voice silent and clicks running, the monitor peaked at 0.62 and the recorded take at 0.000. A voiced take measured 0.25 by the same method.
- Grid take: a 4-beat count-in, one bar recorded and stopped by itself, "On the grid", and Play loop scheduled the loop 0.00 ms off a bar line with a 2.000 s buffer.
- Feedback guard with release at 2000 ms, fed by the output level including the reverb and delay tails: during the probe the voice gain fell from 0.60 to 0.02 in about 120 ms, the mic level fell from 0.102 to 0.015, and the guard tripped about 150 ms into the probe.
- Latency panel: 112 ms from browser-reported values (mic 10.0, pitch window 21.3, analysis wait 14.5, context 10.0, output 56.0).
- At a 375 px viewport the page had no horizontal scroll.

## Manual, in Chromium (v0.3.2, not rerun)

- Sandbox LFO (isolated) and Ghost Radio (trusted) both loaded and rendered their controls. Unload removed the sandbox iframe.
- A cross-origin iframe, and a sandboxed frame redirecting itself to another origin, were both blocked by frame-src.
- With a synthetic tone, the worklet path read 110, 147, 262, 330, 660, 880 and 1100 Hz correctly on the display and at the synth oscillator.
- Loading the sandboxed plugin twice in quick succession created one iframe, and the page could not read into the frame.

## Not tested

- No physical microphone, speakers, MIDI device or speech service was used. Pitch tracking, the feedback guard and the looper were exercised only with synthetic signals. Offline reload after the first visit was not tried.
- MIDI learn with a real controller, including a learned CC reaching a loaded plugin's slider. The learn controls rendered and armed, but no MIDI device was available.
- How a sung take lines up with the click by ear. The loop lands exactly on the bar line, but the latency compensation behind the take's start was checked only against browser-reported values, not measured acoustically.
