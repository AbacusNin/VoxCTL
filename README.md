# VoxCTL v0.4.0

**Your voice is the control surface.**

VoxCTL is a theremin you play by singing. It listens to your microphone and drives a synth with the pitch and loudness of your voice. Sing higher and the synth goes higher; sing louder and it gets louder. It runs entirely in the browser, with no server, no install, and no build step.

Play it at [abacusnin.github.io/VoxCTL](https://abacusnin.github.io/VoxCTL/). Use headphones.

## What it does

- Tracks the pitch of one voice from 65 to 1400 Hz with the McLeod pitch method. An AudioWorklet collects the samples and the tracker runs on the main thread, so the synth never waits on the analysis.
- Free mode follows your pitch continuously. Quantized mode pulls it onto a scale and holds each note until you move clearly toward the next, so a voice sitting between two notes does not flicker. An optional free-mode hold, off by default, keeps small wobbles out.
- Built-in scales, plus custom microtonal scales entered in cents, tuned to an A4 reference you set from 430 to 450 Hz.
- A cents tuner shows how far your raw pitch sits from the nearest semitone, before any quantizing.
- Attack, release and a loudness curve shape how the synth follows your voice.
- A latency panel estimates the voice-to-sound delay from what the browser reports, and says which parts it could not get.
- A mapping matrix routes other features of your voice (brightness, noisiness, vibrato, and rough formant estimates) to filter, detune, delay, reverb, and output level.
- Records the synth, and loops a take against a tempo grid with a metronome click and a one-bar count-in while you play over it.
- Sends your pitch out over Web MIDI as notes and pitch bend, or lets a MIDI keyboard take over the pitch. MIDI learn binds a controller's knobs to the sliders.
- Saves presets in the browser, and imports and exports them as JSON.
- Runs plugins: a trusted bundled plugin in the page, and control plugins in a sandboxed iframe.
- Works offline after the first visit.

## Headphones

On speakers the synth reaches the microphone and the tracker hears it as your voice. Output follows mic loudness, so that loop can keep itself going after you stop singing.

A feedback guard catches most of these loops. After 3 seconds of unbroken sound it mutes the synth for 300 ms. A singer keeps going through the gap, but a loop loses its source and the mic level collapses. When that happens the guard keeps the synth muted and shows a warning until the mic has been quiet for a second. It checks at most once every 20 seconds, so a long note held on speakers hears a short gap now and then.

The guard cannot catch a recorded take or the metronome click coming through your speakers, because muting the synth does not stop them. Worse, while a loop plays on speakers the guard cannot catch the synth either, because the loop keeps the mic level up through its check. Loop on headphones.

The guard's mute is its own fast path. A long Release setting slows the voice fading at a note end, but never the guard.

## Privacy

Pitch tracking happens on your machine and no audio leaves it. Recording captures the synth's output, not your raw microphone, and not the loop or the click.

Spoken commands are optional and off by default. While they are on, the browser streams your microphone to its speech service: Chrome sends it to Google and Edge sends it to Microsoft.

## Running it locally

VoxCTL is a static site. Serve the folder over HTTP and open it in a browser:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000/`. Opening `index.html` over `file://` will not work, because ES modules, the audio worklet, and microphone access all need a real origin.

Chrome and Edge get every feature. Other browsers run the core instrument, and the pre-flight panel at the top of the page shows which optional parts (AudioWorklet, MIDI, recording, speech) are available.

## MIDI

Click **Connect MIDI** and pick a port. As an input, a keyboard's notes and pitch bend override your voice. As an output, the theremin sends notes, pitch bend, and CC11 expression. It holds a note while your voice stays within 1.5 semitones of it and bends the rest of the way, so set the receiver's bend range to 2 semitones. Notes are relative to your A4 reference, so set the receiver's master tune to match.

To bind a knob, pick a slider under **Learn target**, press **Learn CC** and move the knob. [docs/MIDI.md](docs/MIDI.md) has the details.

## Looper

Set BPM, beats per bar and bars, then **Start tempo** for a click. With **Record to the grid** checked, Record counts in one bar, records the set number of bars and stops on its own; the take is then ready to loop in time. Without it, Record works as before and runs until you press Stop. **Play loop** starts the last take on the next bar. A take is fitted to the loop by changing its speed, which changes its pitch too, and a fit that would need more than double or less than half speed is refused with a suggestion. **Loop offset** nudges a grid take against the click if it sounds early or late. [docs/PERFORMANCE.md](docs/PERFORMANCE.md) covers the timing.

## Microtonal scales

Choose **Custom / microtonal** and enter scale degrees in cents within one octave, up to 128 of them:

- Major: `0, 200, 400, 500, 700, 900, 1100`
- 24-tone equal temperament: `0, 50, 100, 150, ... 1150`
- A just-intonation set: `0, 112, 386, 498, 702, 814, 1088`

The root selector transposes the set.

## Plugins

A plugin declares the capabilities it needs in a manifest, and the host hands it controls for those and nothing else. Ghost Radio, the bundled trusted plugin, runs in the page. Every other plugin runs in a sandboxed iframe with an opaque origin, its own locked-down CSP, and a private message port as its only line to the host, which checks and clamps every value it receives. Each sandboxed plugin's source hash has to be listed in the page CSP, so only plugins shipped with the app can run.

The sandbox keeps a plugin out of the page's DOM and storage, but it does not fully contain hostile code. [docs/SECURITY.md](docs/SECURITY.md) lists what a sandboxed plugin can still do, and [docs/PLUGIN_SPEC.md](docs/PLUGIN_SPEC.md) covers the API.

## Limits

- One voice at a time. Chords and harmony are not tracked.
- Pitches above 1400 Hz, which covers most whistling, read as silence.
- Formant estimates are meant for musical control, not phonetics.
- Loop playback and the click run outside the effects chain and outside the feedback guard's reach.
- Takes record the synth only; there is no overdub yet.
- Loop fitting changes speed and pitch together, with no time stretching.
- Sandboxed plugins control parameters; they cannot process audio.

## Tests

```bash
node --test tests/*.test.mjs
```

The suite needs no packages and was run on Node 24. [docs/VALIDATION.md](docs/VALIDATION.md) lists what it covers and what was checked in a browser.

## Documentation

- [ARCHITECTURE](docs/ARCHITECTURE.md): how audio moves from the microphone to the synth
- [SIGNAL_SPEC](docs/SIGNAL_SPEC.md): the voice features and their ranges
- [PERFORMANCE](docs/PERFORMANCE.md): tuning, the tuner, dynamics, the latency estimate, looper timing and MIDI learn
- [PLUGIN_SPEC](docs/PLUGIN_SPEC.md): manifests, capabilities, and the sandbox bridge
- [PRESET_FORMAT](docs/PRESET_FORMAT.md): the preset JSON format
- [MIDI](docs/MIDI.md): MIDI input and output, and MIDI learn
- [SECURITY](docs/SECURITY.md): the privacy and plugin trust model
- [CHANGELOG](CHANGELOG.md)

## License

VoxCTL is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, study, change, and share it for any noncommercial purpose: personal projects, hobby use, study, research, and use by charities, schools, and public institutions.

**Commercial use needs a separate license.** That includes building VoxCTL into a product or service, or offering it on a platform. For commercial licensing, email abacusnin@gmail.com.

Copyright (C) 2026 Abacus.
