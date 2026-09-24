# Architecture, v0.3.2

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
                                              noise gate ─► FeatureEngine
                                                                       │
                                  ┌───────────────┬────────────────────┤
                                  ▼               ▼                    ▼
                          FeedbackGuard     MappingEngine          PluginHost
                                  │               │                    │
                                  ▼               │                    │
                    PitchTracker (median, sticky  │                    │
                    quantize) ─► setPitch(midi)   │                    │
                                  │               ▼                    ▼
                                  └─────────► AudioEngine ◄── capability offsets
      oscillator.detune (pitch, cents) + ConstantSource (mapping/plugin detune)
      voice gain ─► filter ─► dry / delay / reverb ─► master ─► limiter
                                                                   │
                                                  speakers ◄───────┤
                                                                   └─► MediaStreamDestination ─► MediaRecorder

Web MIDI input ─────► optional pitch override (played on arrival)
heard pitch ────────► optional Web MIDI output
```

## Core subsystems

### AudioEngine
Owns the Web Audio graph, microphone stream, oscillator, voice gain, filter, delay, convolution reverb, master bus, output limiter, AudioWorklet connection and the recording tap. The oscillator's frequency is fixed at 440 Hz and pitch is set in cents on its `detune` param with a single `setTargetAtTime` glide on the audio clock, so a glide is even in semitones and lasts the same on either analysis path. The first voiced frame after silence jumps straight to the note. Mapping and plugin detune feed the same param from a separate ConstantSourceNode; AudioParam inputs sum with the param's own value, so the two never cancel each other's ramps.

A DynamicsCompressor limiter (threshold -6 dB, ratio 12) sits between the master gain and the destination. The recorder taps the limiter output, so a take matches what was heard.

`suspend()` zeros the voice and suspends the context when the tab is hidden. While a take is recording it only zeros the voice, so the take records silence instead of a gap.

### Analysis worklet
Collects microphone samples in a ring buffer and posts one window every 30 ms to the main thread, transferring the buffer instead of copying it. It runs no analysis: the audio thread also renders the synth, and a pitch search in `process()` can overrun the 2.67 ms render quantum.

### PitchDetector
The one pitch detector, used by both paths. It runs the McLeod pitch method: a normalized square difference function, then the first key maximum within 85% of the highest one. Range is 65 to 1400 Hz; a tone whose period is shorter than the 1400 Hz lag reads unvoiced rather than an octave low. The window is the smallest power of two that holds two periods of 65 Hz: 2048 samples at 44.1 and 48 kHz, 4096 at 96 kHz. Above 50 kHz it averages sample pairs down to half rate before searching.

### PitchTracker
Turns detector readings into the pitch the synth plays. It takes a 3-frame median, and in Quantized mode keeps the held scale degree until the voice is 0.25 semitones closer to another one (custom scales included). It resets on every unvoiced frame and reports a jump for the next voiced one. It does no smoothing of its own.

### FeedbackGuard
Catches the synth hearing itself through speakers. After 3 s of unbroken voice it asks the app to mute for 300 ms and watches the lowest mic level across that probe. If it falls below 30% of the level before the probe, it reports feedback until the mic has been quiet for 1 s. Probes are at least 20 s apart. It is skipped while MIDI input drives pitch, since output then does not follow the mic. It cannot see loop playback of a recorded take.

### FeatureEngine
Enriches pitch and RMS with spectral centroid, brightness, noisiness, coarse formant estimates, and vibrato. Vibrato is measured on a pitch track detrended by a moving average about one cycle wide, and is reported only for periodic wobble between 2 and 10 Hz.

### CalibrationEngine
Samples ambient RMS for 2 s, estimates a noise floor and a high ambient percentile, and derives a voice gate. It always resolves, and reports whether browser storage accepted the result.

### MappingEngine
Maps normalized feature sources onto bounded modulation destinations. Direct voice-pitch and voice-loudness control remain the primary path; matrix routes are additive modulation.

### MidiManager
Requests Web MIDI only on explicit user action. It supports one selected input and one output. Input note and pitch bend can override oscillator pitch. Output holds a note while the pitch stays within 1.5 semitones of it, carries the rest in 14-bit pitch bend over a ±2-semitone range, and sends level changes as CC11. See `MIDI.md`.

### PresetManager
Stores user presets in localStorage and provides a versioned JSON interchange format. Every read and import passes through `sanitizeState`, which rebuilds the state from allowlisted fields. See `PRESET_FORMAT.md`.

### PluginHost
Validates manifests, capability allowlists, plugin UI declarations, same-origin URLs and execution mode. Per-plugin modulation contributions are summed and clamped, so plugins do not overwrite one another and unloading one removes only its own offsets. See `PLUGIN_SPEC.md`.

### Service worker
Network-first for same-origin GET requests, with the cache as the offline fallback. It caches every runtime file on install and takes over open pages at once, so a deployed fix reaches returning visitors on their next load.

## Trust boundaries

The host page is trusted. Only bundled manifests on a fixed allowlist may run `execution: trusted`; those modules share the page realm and must be reviewed as application code.

Everything else runs `execution: isolated`. The host fetches the plugin source from the same origin, puts it in a `srcdoc` iframe with `sandbox="allow-scripts"` (an opaque origin), and hands the frame a MessageChannel port on its first load. The port is the only path back to the host. The frame inherits the page CSP, whose script-src lists the sha256 of the sandbox runtime and of each bundled isolated plugin. The page also refuses to run when framed by another site.

The sandbox does not stop a plugin from using CPU, and it cannot host third-party AudioWorklet DSP. `SECURITY.md` lists what a sandboxed plugin can still do.
