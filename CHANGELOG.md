# Changelog

## v0.4.0

"Feel": controls for how the instrument responds, a tempo looper and MIDI learn. The features were ported from a v0.4 prototype built on the unfixed v0.3 code, onto VoxCTL's own architecture. None of its files were copied.

### Added

- Reference A4 from 430 to 450 Hz. It sets the oscillator's base frequency, and every MIDI number in the app is relative to it, so quantizing, custom cents scales, the note readout, the tuner and MIDI out all follow it. Changing it mid-note does not reset the pitch tracker: the tracker shifts its recent pitches into the new reference, so a swept reference glides instead of jumping, and MIDI out bends instead of retriggering.
- A cents tuner under the scope. It shows the raw detected pitch against the nearest semitone of the reference, before the median, the hysteresis and quantizing, and names the note it measures against.
- Attack (1 to 500 ms), Release (5 to 2000 ms) and a Loudness curve (0.25 to 2.5) for the voice gain. The defaults reproduce v0.3.2's time constants. Attack or release is chosen against where the gain actually is, not the last target.
- The voice gain now has two ways down. release() is the note end and follows the Release setting. mute() is a fixed 35 ms path for the feedback guard, calibration, a hidden tab and a stalled worklet. With the release as the guard's mute, a long release kept the synth sounding through the 300 ms probe: in simulation, a 250 ms speaker delay went uncaught from a 300 ms release up.
- Free-mode hysteresis, 0 to 25 cents, default 0 (off). The hint says what it costs: it removes vibrato shallower than the setting, stairs slow slides, and can hold a note up to the setting off pitch. Quantized mode keeps its own hold and skips this one.
- A latency estimate: mic track, half the pitch window, half the analysis cadence, audio context and output device, from values the browser reports. Unreported parts say so and mark the total with a +. It is labeled an estimate, not a measurement.
- A tempo looper: BPM, beats per bar and bars, a metronome click, and Record to the grid, which counts in one bar (clicked even with the metronome off), records the set bars and stops on its own. Loops start on the next bar. A take is trimmed to its grid, or fitted by playback rate between 0.5x and 2x with the pitch change stated; anything outside that is refused with a suggested bar count instead of clamped. Take alignment uses the recorder's start call time plus a latency estimate and a Loop offset nudge. Loop and click levels have their own sliders.
- Loop playback and the click join the output limiter beside the synth, so Output, mappings and plugin ducking do not touch them. The recorder now taps a twin limiter on the synth alone.
- MIDI learn for every slider, including loaded plugins' sliders: pick a target, press Learn CC, move a control. CCs 0 to 119 on any channel; channel mode messages never bind. The arm times out after 15 s. A CC applies through the slider's own input event at most once every 16 ms. Bindings are validated on every read and saved in this browser.
- Preset schema 2, with the Feel controls, optional tempo and optional MIDI learn bindings. Every number is clamped and snapped to its slider's step. Schema 1 files import with their v1 fields only, stored 0.3.x presets upgrade on read under the same key, and a newer schema is refused with its own message. Bindings travel in a preset only when Include MIDI learn bindings is checked.
- docs/PERFORMANCE.md.

### Changed

- A MIDI CC never reaches the MIDI override logic. In v0.3.2, with override on and no key held, one CC muted the voice and made MIDI out send a note-off and a new note-on.
- CC 120 and CC 123 (a panic button) release held keys, so MIDI override lets go.
- Takes record the synth only. v0.3.2 recorded after the output limiter; the loop and click now share that limiter, so the recorder moved to its own. The looping checkbox on the review player is gone; loop the take with Play loop instead.
- Calibration stops the tempo and any loop first, so the click cannot raise the noise floor. A hidden tab stops them too; a take already recording carries on, as before.
- A falling voice level while voiced now eases over 35 ms instead of 18 at the default release.

### Left out on purpose

- The prototype's octave guard. It held a real sung octave leap, 220 to 440 Hz for 1.8 s, at 220 Hz the whole time. VoxCTL's McLeod detector has no octave errors on its test signals for a guard to fix.
- The prototype's 14 cent free-mode hysteresis default. It turned a ±10 cent vibrato into one flat pitch. The option is here, off by default and capped at 25 cents.
- The prototype's visual patchbay. v0.5 replaces the mapping model it draws.
- Overdub. MediaRecorder cannot start sample-accurately and each pass would be re-encoded lossily. It waits for v0.5, when the loop and the recorder become routing destinations.
- A getUserMedia latency constraint the prototype added. It changes device behavior and was untested.

## v0.3.2

- Renamed the project from VoxFlux to VoxCTL, because another product already uses the VoxFlux name. Storage keys, the preset schema name, the sandbox runtime, and the service worker cache were renamed with it, so presets and calibration saved under VoxFlux do not carry over. The site moved to abacusnin.github.io/VoxCTL/.

## v0.3.1

A fix release for v0.3.0. Each item says what was wrong and what changed.

### Pitch and sound

- Pitch detection is now McLeod (NSDF with key-maximum picking) instead of YIN. When no YIN dip crossed its threshold, which happens with a weak fundamental plus room noise, YIN fell back to the global minimum and read notes one or more octaves low at about 84% confidence. On synthetic voices at 48 kHz and about 7 dB SNR, YIN read 35 of 60 test notes wrong and McLeod read none. The range stays 65 to 1400 Hz.
- Tones above 1400 Hz now read unvoiced. They used to read one octave down as voiced, so whistling played an octave low.
- One detector module serves both analysis paths. The AudioWorklet only collects samples and posts raw windows by transfer; the detector runs on the main thread. v0.3.0 ran the pitch search inside process(), which took up to 71% of the 2.67 ms render quantum at 48 kHz and overran it at 96 kHz, and it kept a second, drifting copy of the detector.
- The analysis window is sized from the sample rate (2048 samples at 44.1 and 48 kHz) instead of a fixed 4096, and both paths analyze every 30 ms. This roughly halves the pitch latency. At 96 kHz the detector averages sample pairs down to half rate to keep the cost near 2 ms per frame.
- Pitch glides once, on the audio clock, in semitones through the oscillator's detune. v0.3.0 smoothed with a per-frame average and then glided again, so the Glide slider meant 816 to 1046 ms at the 500 ms setting depending on path and display rate, and every phrase swooped in from the last phrase's note. The first voiced frame after silence now lands on the note.
- Mapping and plugin detune ride on a separate source summed into the oscillator's detune. The note readout and MIDI output now include it, so the sound, the display and MIDI agree.
- Quantized mode keeps the current note until the voice is clearly closer to another degree, and a 3-frame median drops one-frame glitches. A voice near a note boundary used to flip notes on nearly every frame, in the synth and on MIDI out. This works for custom scales too.
- A limiter now sits before the output, and the recorder taps after it. At high settings the dry, delay and reverb paths could sum past full scale and clip, in the speakers and in the take.
- Plugins can only lower the master level, never raise it past the Output slider.

### Safety

- A feedback guard mutes the synth when it hears itself through speakers. After 3 s of unbroken voice it mutes for 300 ms; if the mic level falls below 30% of what it was, that was a loop, and the synth stays muted with a warning until the mic is quiet for a second. It probes at most once every 20 s. Without it a speaker loop could howl on after the singer stopped, because echo cancellation is off and output follows mic level. The loop-playback toggle now warns that the guard cannot catch that path.
- Audio is suspended while the tab is hidden and resumed when it returns. In a hidden tab the fallback path stopped analyzing and the synth droned on its last note; the worklet path kept playing from a tab nobody could see. While a take is recording, the synth is muted instead, so the take records silence rather than a gap. MIDI output sends note-off on hide and on page close.
- Calibration no longer hangs when browser storage is blocked or full. It used to leave the synth muted until reload. The room baseline now applies for the session and the UI says it was not saved. Stored calibration values outside the range calibration can produce are ignored.

### Speech commands

- Fatal errors (not-allowed, service-not-allowed, audio-capture, network, language-not-supported) now stop recognition and uncheck the toggle. v0.3.0 restarted on every end event, in a tight loop, for as long as the page was open.
- The old recognizer is aborted before a new one starts, restarts wait 500 ms, and every new final result is handled from resultIndex instead of only the last one.
- The UI, the README and docs/SECURITY.md now say plainly that Chrome sends microphone audio to Google's servers and Edge to Microsoft's while spoken commands are on.

### Security

- index.html has a Content-Security-Policy. Script sources are limited to the page's origin plus the sha256 of the sandbox runtime and of each bundled isolated plugin; media-src allows blob: so recorded takes play; frame-src is 'self'. A test fails if the hashes go out of date.
- The page refuses to run inside another site's frame. GitHub Pages cannot send a frame-ancestors header and a meta CSP cannot set one.
- Plugin manifest and entry URLs must be same-origin http or https. A manifest without an execution field now runs isolated, and only the bundled Ghost Radio manifest may run trusted. v0.3.0 treated a missing field as trusted and would import any URL, including data: URLs.
- The isolated plugin bridge is a MessageChannel port handed to the frame on its first load. The shared token, which the plugin could read, is gone, and a frame that navigates is unloaded. Plugins receive only whether the voice is sounding unless their manifest asks for the new voice.features.read permission.
- Plugin messages are coalesced to one update per capability every 16 ms, and a plugin that sends more than 400 messages per second is unloaded. A burst used to schedule automation events on every audio parameter for each message.
- Plugin manifests are fully validated, including every ui control. A malformed control used to leave a plugin running while the UI said it failed to load. A failed load now removes any offsets the plugin set, a double click cannot create an orphaned sandbox, and load errors are shown in the UI.
- Stored presets are validated on every read, and every field is checked against an allowlist or the slider range. Preset import is capped at 256 KB, checked before the file is read. Two saves in the same millisecond no longer overwrite each other. Inherited names such as constructor no longer resolve as factory presets.
- Every value the mapping matrix writes into markup is escaped.

### Service worker and app

- The service worker is network-first with the cache as the offline fallback, and it takes over on install. v0.3.0 was cache-first, so returning visitors kept running old code until every tab closed, and the plugin host's no-cache fetches were answered from the cache. It now caches only same-origin successful responses, and the asset list includes the icons and the new modules; a test checks it against the file tree.
- The web app manifest lists the 192 and 512 px icons, and the page links a favicon.
- The Start button is disabled while starting. A double click used to open two mic streams, two worklets and two render loops. Start errors now say whether permission was denied, no microphone was found, or the device was busy.
- The audio status follows the context's real state instead of being set once.
- The scope canvas matches its displayed size times the device pixel ratio, so the trace is sharp and not stretched on phones.
- The pre-flight check no longer shows an ES modules row that could never fail, reports whether service-worker registration succeeded, and checks recording the same way the recorder does.
- MIDI keys and bends play as they arrive instead of at the next analysis frame; a re-struck held note becomes the current note; unplugging a port clears it in both the manager and the UI; calibration stops MIDI output. MIDI output sends pitch bend before note-on, holds a note within 1.5 semitones and bends, and sends CC11 expression as the voice swells.
- Vibrato is measured on a detrended pitch track and reported only for periodic 2 to 10 Hz wobble. A sung melody used to read as 200 cents of vibrato and drive any vibrato-depth mapping to full scale.
- Custom scales: a degree of 1199.9996 cents no longer becomes a spurious extra degree, only plain decimals are accepted, a scale is capped at 128 degrees, and the text is parsed on edit instead of on every frame.
- Recording: Safari's MP4 takes are saved as .m4a instead of .webm, a recorder error mid-take resets the UI, and a stop cannot pick up the next take's audio. Recording or calibrating before Start says to start first. Chrome writes takes as WebM with no duration, so the player showed no length and could not seek; the player now resolves the real duration after loading.
- The app boots into the Classic preset the selector shows; v0.3.0 showed Classic but ran an extra mapping.
- Added the PolyForm Noncommercial License 1.0.0. Noncommercial use is free; commercial use needs a separate license.
- Renamed the project from Voice Theremin to VoxFlux. Storage keys, the preset schema name and the service worker cache were renamed with it, so presets and calibration saved under the old name do not carry over.

### Tests and docs

- Node tests (node --test tests/*.test.mjs) cover the detector, the worklet, glide and quantizing, the feedback guard, calibration, vibrato, MIDI, the plugin host, presets, the CSP hashes, the app wiring and the shipped file set.
- Every doc was rewritten to match the code. docs/VALIDATION.md lists the checks that were actually run.

## v0.3.0

- Replaced normalized autocorrelation pitch tracking with YIN-style fundamental detection in both AudioWorklet and fallback paths.
- Added arbitrary custom/microtonal scales in cents and a Quarter-Tone Lab factory preset.
- Added Web MIDI input/output manager with optional pitch override and theremin note/pitch-bend output.
- Added master-bus recording, browser playback looping, and take download.
- Added versioned preset JSON import/export.
- Upgraded plugin API to v0.3 with manifest-defined host UI controls.
- Added additive per-plugin capability contributions instead of last-writer-wins offsets.
- Added isolated control-plugin execution using sandboxed iframe, opaque origin, restrictive CSP, tokenized postMessage bridge, and host-side capability validation.
- Added Sandbox LFO isolated example; upgraded Ghost Radio to API v0.3.
- Updated service worker cache and architecture/security documentation.

## v0.2.0

- Added AudioWorklet analysis with fallback detector.
- Added room calibration, voice feature enrichment, mapping matrix, local presets, and plugin capability broker.

## v0.1.1

- Added browser compatibility self-test and core startup gating.

## v0.1.0

- Initial GitHub Pages-native voice theremin prototype.
