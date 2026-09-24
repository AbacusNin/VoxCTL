# Signal Specification, v0.3.1

The feature object passed through the mapping and plugin layers may contain:

| Signal | Meaning |
|---|---|
| `pitchHz` | Detected monophonic fundamental frequency, 65 to 1400 Hz; 0 when unvoiced |
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

`pitchHz` drives oscillator pitch and `rms` drives voice gain. These are not mapping-matrix routes; they define the instrument's baseline behavior. Pitch passes through a 3-frame median and, in Quantized mode, sticky quantizing before a single glide on the audio clock.

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
