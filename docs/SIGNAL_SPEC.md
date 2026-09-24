# Signal Specification, v0.4.0

The feature object passed through the mapping and plugin layers may contain:

| Signal | Meaning |
|---|---|
| `pitchHz` | Detected monophonic fundamental frequency in Hz, 65 to 1400; 0 when unvoiced. Raw Hz, not affected by the A4 reference |
| `confidence` | Height of the chosen NSDF peak, 0 to 1; frames below 0.62 are unvoiced |
| `rms` | Time-domain RMS amplitude |
| `zcr` | Zero-crossing rate |
| `brightnessProxy` | Time-domain brightness proxy |
| `voiced` | Whether the detector considers the frame a stable voiced signal and it cleared the noise gate |
| `detector` | Detector identifier (`mpm`, the McLeod pitch method) |
| `noiseGate` | Current calibrated or default RMS gate |
| `spectralCentroid` | Spectrum-weighted center frequency |
| `brightness` | Normalized high-frequency energy estimate |
| `noisiness` | Combined ZCR and confidence noisiness estimate |
| `formant1` | Experimental first spectral-envelope peak |
| `formant2` | Experimental second spectral-envelope peak |
| `vibratoRate` | Vibrato rate in Hz, 2 to 10, or 0 when there is none |
| `vibratoDepth` | Vibrato depth in cents on the detrended pitch track, or 0 when there is none |

Both analysis paths produce a frame every 30 ms from the same detector.

Plugins receive only `voiced` unless their manifest requests the voice.features.read permission; with it they receive every finite number and boolean above.

## Primary control path

`pitchHz` drives oscillator pitch and `rms` drives voice gain. These are not mapping-matrix routes; they define the instrument's baseline behavior.

Pitch is converted to MIDI numbers relative to the A4 reference (430 to 450 Hz, default 440), so note 69 is A4 at the reference. It passes through a 3-frame median, then either sticky quantizing (Quantized mode) or the optional free-mode hysteresis (free mode, 0 to 25 cents, default 0), before a single glide on the audio clock. The cents tuner reads `pitchHz` before all of that: it shows the gated detector pitch against the nearest equal-tempered semitone of the reference, before the median, the hysteresis and quantizing.

`rms` is normalized above the noise gate to 0 to 1, raised to the Loudness curve exponent (0.25 to 2.5, default 0.72), and scaled to the synth's voice gain. The gain rises with the Attack time and falls with the Release time, each to about 95 percent. It works as an envelope follower: Release applies to every falling level while the voice sounds, not only at the end of a note, so a long release also slows a decrescendo. The feedback guard, calibration, a hidden tab and a stalled worklet do not use the Release time; they mute with a fixed 35 ms time constant. MIDI output velocity and CC11 stay linear in the voice level.

## Mapping sources

- voice.rms
- voice.brightness
- voice.noisiness
- voice.pitchConfidence
- voice.vibratoDepth
- voice.vibratoRate
- voice.formant1
- voice.formant2

## Mapping destinations

- synth.filterCutoff
- synth.detune
- fx.delayMix
- fx.reverbMix
- master.gain

Mappings are normalized and bounded before reaching the AudioEngine. Detune from mappings is applied after quantizing, so a detune mapping can move a quantized note off the scale on purpose; the note readout and MIDI output include it.
