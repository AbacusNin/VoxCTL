# Architecture, v0.4.0

## Overview

VoxCTL turns features of a live voice into control signals and routes them to a synth, to MIDI, and to plugins. It ships as static files for GitHub Pages; nothing runs on a server.

## Runtime flow

```text
Microphone
   │
   ├────────────► AnalyserNode ─────► spectrum for formant/brightness features
   │                   │
   │                   └─ (no AudioWorklet) newest window every 30 ms ─┐
   │                                                                   │
   └────────────► AudioWorklet: ring buffer only,                      │
                  posts a raw window every 30 ms by transfer ──────────┤
                                                                       ▼
                                          PitchDetector (McLeod NSDF), main thread
                                                                       │
                                                                       ▼
                                   noise gate ─► FeatureEngine ─► cents tuner
                                                                       │
                                  ┌───────────────┬────────────────────┤
                                  ▼               ▼                    ▼
                          FeedbackGuard     MappingEngine          PluginHost
                                  │               │                    │
                                  ▼               │                    │
                    PitchTracker (median, free    │                    │
                    hold or sticky quantize)      │                    │
                      ─► setPitch(midi)           │                    │
                                  │               ▼                    ▼
                                  └─────────► AudioEngine ◄── capability offsets
      oscillator.frequency = A4 reference; oscillator.detune (pitch, cents)
        + ConstantSource (mapping/plugin detune)
      voice gain (attack, release, curve) ─► filter ─► dry / delay / reverb ─► master

        master ─► limiter ─► speakers
       loopBus ─► limiter          (loop playback, not recorded)
      clickBus ─► limiter          (metronome and count-in, not recorded)
        master ─► recLimiter ─► MediaStreamDestination ─► MediaRecorder

Web MIDI input ─────► optional pitch override (played on arrival)
Web MIDI CC ────────► MIDI learn ─► UI slider 'input' event
heard pitch ────────► optional Web MIDI output
```

## Core subsystems

### AudioEngine
Owns the Web Audio graph, microphone stream, oscillator, voice gain, filter, delay, convolution reverb, master bus, both limiters, the loop and click buses, the AudioWorklet connection and the recording tap.

Pitch lives in cents on the oscillator's `detune` param, with a single `setTargetAtTime` glide on the audio clock, so a glide is even in semitones and lasts the same on either analysis path. The first voiced frame after silence jumps straight to the note. The oscillator's `frequency` is the A4 reference, 440 Hz by default and 430 to 450 Hz on the slider, so every MIDI number in the app is in reference space: note 69 is A4 at the reference. Mapping and plugin detune feed the same param from a separate ConstantSourceNode; AudioParam inputs sum with the param's own value, so the two never cancel each other's ramps.

A reference change steps `oscillator.frequency` at once. In free mode the voice-following detune is corrected on the next analysis frame, up to about 30 ms later, so a preset that moves the reference by 10 Hz can sound about 39 cents off for one frame. Quantized notes and held MIDI keys simply sound at the new tuning.

The voice gain has two ways down:

- `release()` is the musical note end. It follows the Release setting.
- `mute()` is the safety path, used by the feedback guard, calibration, a hidden tab and a stalled worklet. It uses a fixed 35 ms time constant and never reads the dynamics settings.

With the release time as the mute, a 2 s release would still be loud when the guard's 300 ms probe ended, and the guard could never see a speaker loop. A simulation with the real FeedbackGuard and a 250 ms (Bluetooth) speaker delay caught the loop at 35 ms and missed it with a release of 300 ms or more. A mute is idempotent: while one is in force, `mute()` schedules nothing and `release()` is ignored, because the gain is already falling faster than a release would take it. A later `setTargetAtTime` supersedes a running long release, so the mute needs no cancel (checked in Chromium with OfflineAudioContext).

Attack and release are chosen against a model of where the gain is now, not the last target. `levelAt(t)` replays the `setTargetAtTime` curve; it matched Chromium to 1e-4 over 120 mixed events. Times are to about 95 percent (time constant = ms / 3), the same convention as glide. Release applies to every falling level while voiced, so a long release also slows a decrescendo. The loudness curve is the exponent on the normalized voice level. It shapes the synth gain only; MIDI velocity and CC11 stay linear.

The heard path has one DynamicsCompressor limiter (threshold -6 dB, knee 6, ratio 12). Master, the loop bus and the click bus all feed it. Loop playback and the click therefore never pass through the Output slider, master mappings or plugin ducking, and the heard path gains no latency; each compressor delays the signal by about 6 ms, measured in Chrome. A loud loop or click can briefly compress the heard synth. The recorder taps a twin limiter with the same settings on master alone, so a take is the synth only. With no loop playing it matches what was heard (identical peaks in Chrome).

`suspend()` zeros the voice and suspends the context when the tab is hidden. While a take is recording it only zeros the voice, so the take records silence instead of a gap.

### Analysis worklet
Collects microphone samples in a ring buffer and posts one window every 30 ms to the main thread, transferring the buffer instead of copying it. It runs no analysis: the audio thread also renders the synth, and a pitch search in `process()` can overrun the 2.67 ms render quantum.

### PitchDetector
The one pitch detector, used by both paths. It runs the McLeod pitch method: a normalized square difference function, then the first key maximum within 85% of the highest one. Range is 65 to 1400 Hz; a tone whose period is shorter than the 1400 Hz lag reads unvoiced rather than an octave low. The window is the smallest power of two that holds two periods of 65 Hz: 2048 samples at 44.1 and 48 kHz, 4096 at 96 kHz. Above 50 kHz it averages sample pairs down to half rate before searching.

### PitchTracker
Turns detector readings into the pitch the synth plays. It takes a 3-frame median. In Quantized mode it keeps the held scale degree until the voice is 0.25 semitones closer to another one (custom scales included). In free mode an optional hold, off by default and capped at 25 cents, keeps the output still until the voice moves further than the setting. That hold removes vibrato shallower than the setting, turns slow slides into steps of about the setting, and can hold a steady offset up to the setting for as long as the voice stays there. Quantized mode skips it, so the two holds never stack.

It resets on every unvoiced frame and reports a jump for the next voiced one. A reference change does not reset it. The pitches in the median and the free-mode hold shift by 12 log2(old / new) into the new reference, and the quantized held note, a scale degree, stays. A reset would report a jump, and a reference swept from a slider or a learned knob changes on nearly every frame, which would bypass the glide for the whole sweep. The tracker does no smoothing of its own and has no octave guard.

### FeedbackGuard
Catches the synth hearing itself through speakers. After 3 s of unbroken voice it asks the app to mute for 300 ms and watches the lowest mic level across that probe. If it falls below 30% of the level before the probe, it reports feedback until the mic has been quiet for 1 s. Probes are at least 20 s apart. It is skipped while MIDI input drives pitch, since output then does not follow the mic.

It cannot see loop playback or the click, which join after the voice gain. A loop on speakers also hides a synth loop from it. Once playback made up 30% or more of the mic level, a simulated synth loop was never caught, because the loop kept the level up through the probe. The UI says so next to the loop controls.

### LoopEngine
The tempo looper, in `src/audio/loop-engine.js`. A transport sets the downbeat of bar 1 0.1 s ahead of the context clock. A lookahead scheduler wakes every 25 ms and schedules each click in the next 120 ms as an AudioBufferSourceNode into the click bus. Beats already in the past are dropped, never played late, and finished nodes are pruned. A main-thread stall therefore skips clicks, and the node set stays bounded. Clicks are 20 ms sine bursts at 2400 Hz (beat 1) and 1800 Hz, above the detector's 1400 Hz ceiling, so a click leaking into the mic reads unvoiced while the singer is silent. Mixed into a sung note, a loud leak bent the note by up to 33 cents for one window; a quiet one stayed within 7 cents.

A take recorded to the grid gets a one-bar count-in whose clicks sound even with the metronome off. One state machine (idle, count-in, recording, idle) owns the recorder start 0.15 s before the take and the auto-stop. `cancelTake()` is its only exit, and every stop path uses it: the Stop button, the speech command, Stop tempo, calibration, a recorder error and a hidden tab. A count-in canceled from a transport the take itself started also stops that transport, so its clicks end with it. A transport the user started keeps running. While a grid take owns the recorder, the speech command 'record' does nothing.

A take's grid offset is the time from the recorder's start call to the downbeat, plus a latency estimate and a user nudge (see `PERFORMANCE.md`). After a take, the app decodes it into a mono loop buffer of exactly the loop length. A take recorded to the same grid is trimmed and plays at rate 1. Anything else is fitted by playback rate, which changes speed and pitch together. A fit outside 0.5x to 2x is refused with a suggested bar count, never clamped, because a clamped rate drifts every cycle. A take too long to ever fit is not decoded. A new loop replaces the playing one at the next bar line.

### Latency estimate
`src/audio/latency.js` sums what the browser reports (track latency, `baseLatency`, `outputLatency`) with half the pitch window and half the analysis cadence. A value the browser does not report shows as not reported, and the total is marked partial. It is an estimate, not a measured round trip.

### FeatureEngine
Enriches pitch and RMS with spectral centroid, brightness, noisiness, coarse formant estimates, and vibrato. Vibrato is measured on a pitch track detrended by a moving average about one cycle wide, and is reported only for periodic wobble between 2 and 10 Hz. It measures in cents from a fixed 440 Hz; only cents differences are used, so the A4 reference does not affect it.

### CalibrationEngine
Samples ambient RMS for 2 s, estimates a noise floor and a high ambient percentile, and derives a voice gate. It always resolves, and reports whether browser storage accepted the result. The app stops the transport and any loop first, so the click cannot raise the measured floor.

### MappingEngine
Maps normalized feature sources onto bounded modulation destinations. Direct voice-pitch and voice-loudness control remain the primary path; matrix routes are additive modulation.

### MidiManager and MIDI learn
MidiManager requests Web MIDI only on explicit user action. It supports one selected input and one output. Input note and pitch bend can override oscillator pitch. Output holds a note while the pitch stays within 1.5 semitones of it, carries the rest in 14-bit pitch bend over a ±2-semitone range, and sends level changes as CC11. CC 120 and CC 123 release held keys.

MIDI learn, in `src/midi/midi-learn.js`, binds a CC to a UI slider. The app handles every CC before the override logic and returns, so a CC never touches MIDI override. A bound CC sets the slider and dispatches the same `input` event a hand drag does, at most once per slider every 16 ms. See `MIDI.md`.

### PresetManager
Stores user presets in localStorage and provides a versioned JSON interchange format, now schema 2. Every read and import passes through `sanitizeState`, which rebuilds the state from allowlisted fields. See `PRESET_FORMAT.md`.

### PluginHost
Validates manifests, capability allowlists, plugin UI declarations, same-origin URLs and execution mode. Per-plugin modulation contributions are summed and clamped, so plugins do not overwrite one another and unloading one removes only its own offsets. See `PLUGIN_SPEC.md`.

### Service worker
Network-first for same-origin GET requests, with the cache as the offline fallback. It caches every runtime file on install and takes over open pages at once, so a deployed fix reaches returning visitors on their next load.

## Trust boundaries

The host page is trusted. Only bundled manifests on a fixed allowlist may run `execution: trusted`; those modules share the page realm and must be reviewed as application code.

Everything else runs `execution: isolated`. The host fetches the plugin source from the same origin, puts it in a `srcdoc` iframe with `sandbox="allow-scripts"` (an opaque origin), and hands the frame a MessageChannel port on its first load. The port is the only path back to the host. The frame inherits the page CSP, whose script-src lists the sha256 of the sandbox runtime and of each bundled isolated plugin. The page also refuses to run when framed by another site.

The sandbox does not stop a plugin from using CPU, and it cannot host third-party AudioWorklet DSP. `SECURITY.md` lists what a sandboxed plugin can still do.
