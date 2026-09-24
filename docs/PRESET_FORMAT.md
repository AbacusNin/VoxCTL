# Preset Interchange Format, v0.4.0

Exported presets are JSON data, not executable plugins.

```json
{
  "schema": "voxctl-preset",
  "schemaVersion": 2,
  "appVersion": "0.4.0",
  "name": "My patch",
  "state": {
    "pitchMode": "quantized",
    "scale": "custom",
    "root": "D",
    "customScale": [0, 200, 300, 500, 700, 800, 1000],
    "waveform": "sine",
    "quantize": 80,
    "glide": 60,
    "filter": 4200,
    "delay": 18,
    "reverb": 28,
    "output": 65,
    "referenceA4": 432,
    "freeHysteresis": 0,
    "attack": 54,
    "release": 105,
    "loudnessCurve": 0.72,
    "bpm": 96,
    "beatsPerBar": 4,
    "bars": 2,
    "mappings": [
      { "id": "map-1", "source": "voice.brightness", "destination": "synth.filterCutoff", "amount": 35, "curve": "linear", "enabled": true }
    ],
    "midiLearn": [
      { "cc": 20, "param": "plugin:sandbox-lfo:rate" },
      { "cc": 74, "param": "filter" }
    ]
  },
  "exportedAt": "2026-09-24T12:00:00.000Z"
}
```

`schemaVersion` is the format version, now 2. `appVersion` records which release wrote the file and is not checked on import.

## Import

A file over 256 KB is refused before it is read. The payload must be a JSON object with `schema` `"voxctl-preset"`, a non-empty string `name` and an object `state`.

- `schemaVersion` 1 or 2 is accepted. See Migration.
- An integer above 2 is refused with "This preset was made by a newer VoxCTL (schema N). Update VoxCTL to import it."
- Anything else, including the string `"2"`, is refused as an unsupported schema. So are files with the old `voice-theremin-preset` schema name.

The imported preset is saved under the first 55 characters of its name plus " (import)".

## Validation

The same rules run when a preset is saved, imported, exported or read back from storage. The state is rebuilt from known fields only; anything else is dropped, including `__proto__` and `constructor`.

| Field | Rule | Step | Fallback |
|---|---|---|---|
| `pitchMode` | `free` or `quantized` | | `free` |
| `scale` | a built-in scale name or `custom` | | `minor` |
| `root` | one of the 12 note names, C to B with sharps | | `D` |
| `customScale` | finite numbers within ±12000, at most 128 entries | | `[0, 200, 300, 500, 700, 800, 1000]` |
| `waveform` | `sine`, `triangle`, `sawtooth` or `square` | | `sine` |
| `quantize` | 0 to 100 | 1 | 100 |
| `glide` | 0 to 500 ms | 1 | 45 |
| `filter` | 150 to 12000 Hz | 1 | 4200 |
| `delay` | 0 to 70 | 1 | 18 |
| `reverb` | 0 to 80 | 1 | 28 |
| `output` | 0 to 100 | 1 | 65 |
| `referenceA4` | 430 to 450 Hz | 0.1 | 440 |
| `freeHysteresis` | 0 to 25 cents | 1 | 0 |
| `attack` | 1 to 500 ms | 1 | 54 |
| `release` | 5 to 2000 ms | 1 | 105 |
| `loudnessCurve` | 0.25 to 2.5 | 0.01 | 0.72 |
| `bpm` | 40 to 240, optional | 1 | none |
| `beatsPerBar` | 1 to 12, optional | 1 | none |
| `bars` | 1 to 16, optional | 1 | none |
| `mappings` | at most 64 objects | | empty |
| `midiLearn` | see below, optional | | none |

Numeric fields are clamped to the same ranges as the sliders in the UI and then snapped to the slider's step, so a reference of 432.123 Hz loads as 432.1 Hz. Numeric strings are converted. Anything else takes the fallback, and that includes the strings "Infinity" and "440abc". A test parses index.html and fails if a range, step or default here and on the control disagree.

The Feel fallbacks (reference 440, no free-mode hold, attack 54 ms, release 105 ms, curve 0.72) reproduce v0.3.2. The only audible difference is that a level falling while the voice sounds now takes 35 ms instead of 18.

The tempo fields are optional. A preset carries a tempo field only if the source had a number for it, and loading applies only the fields present, and only while the transport is stopped. Factory presets and 0.3.x presets carry none, so loading one never resets your tempo.

Each mapping gets a `source` from the signal list in `SIGNAL_SPEC.md` (fallback `voice.brightness`), a `destination` from the destination list (fallback `synth.filterCutoff`), an `amount` clamped to -100 to 100, a `curve` of `linear`, `square` or `sqrt`, and `enabled` true unless it is exactly false. Mapping ids must match `[A-Za-z0-9_:-]{1,64}` and be unique; others become `map-N`.

### midiLearn

An array of `{ "cc", "param" }` bindings. Only the first 64 entries are read. An entry is kept only if it is a plain object whose `cc` is an integer from 0 to 119 and whose `param` is a learnable control name from `MIDI.md` or `plugin:<id>:<control>` with the plugin host's own id rules. The first binding for a CC wins, and so does the first for a control. Kept entries are rebuilt as new objects with only those two keys, sorted by CC, at most 32. An empty result writes no key.

Bindings describe your controller, not the sound. They are saved into a preset, and loaded from one, only when **Include MIDI learn bindings** is checked; it is off by default. Loading a preset that carries bindings with the toggle off leaves your bindings alone and says how many the preset has. A factory preset and the boot load never touch them.

## Migration

- A schema 1 file imports with its v1 fields only: `pitchMode`, `scale`, `root`, `customScale`, `waveform`, `quantize`, `glide`, `filter`, `delay`, `reverb`, `output` and `mappings`. Any other key in its state, such as `referenceA4` or `bpm`, is dropped, and the Feel fields take their fallbacks.
- Stored presets keep the key `voxctl.presets.v0.3`. A preset saved by 0.3.x upgrades each time it is read, and nothing is rewritten on load. Renaming the key would orphan 0.3.x presets. Keeping it lets 0.3.2 still read them after a downgrade, because 0.3.2 drops the keys it does not know.
- 0.3.2 cannot import a schema 2 file. It refuses it as an unsupported schema.

## Storage

User presets live in localStorage under `voxctl.presets.v0.3`. Stored ids must match `user:` plus 1 to 16 lowercase letters or digits, the name must be a string of at most 64 characters, and the state must be an object; other entries are ignored. Every page on the same origin shares this storage, which on GitHub Pages means every project site of one account, so stored entries are validated rather than trusted.
