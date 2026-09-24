# Preset Interchange Format, v0.3.2

Exported presets are JSON data, not executable plugins.

```json
{
  "schema": "voxctl-preset",
  "schemaVersion": 1,
  "appVersion": "0.3.2",
  "name": "My patch",
  "state": {
    "pitchMode": "quantized",
    "scale": "custom",
    "root": "D",
    "customScale": [0, 200, 300, 500, 700, 800, 1000],
    "quantize": 80,
    "glide": 60,
    "waveform": "sine",
    "filter": 4200,
    "delay": 18,
    "reverb": 28,
    "output": 65,
    "mappings": [
      { "id": "map-1", "source": "voice.brightness", "destination": "synth.filterCutoff", "amount": 35, "curve": "linear", "enabled": true }
    ]
  },
  "exportedAt": "2026-09-23T12:00:00.000Z"
}
```

`schemaVersion` is the format version and stays 1. `appVersion` records which release wrote the file and is not checked on import.

## Import

A file over 256 KB is refused before it is read. The payload must be a JSON object with `schema` `"voxctl-preset"`, `schemaVersion` 1, a non-empty string `name` and an object `state`. The imported preset is saved under the first 55 characters of its name plus " (import)".

## Validation

The same rules run when a preset is saved, imported, exported or read back from storage. The state is rebuilt from known fields only; anything else is dropped.

| Field | Rule | Fallback |
|---|---|---|
| `pitchMode` | `free` or `quantized` | `free` |
| `scale` | a built-in scale name or `custom` | `minor` |
| `root` | one of the 12 note names, C to B with sharps | `D` |
| `customScale` | finite numbers within ±12000, at most 128 entries | `[0, 200, 300, 500, 700, 800, 1000]` |
| `waveform` | `sine`, `triangle`, `sawtooth` or `square` | `sine` |
| `quantize` | 0 to 100 | 100 |
| `glide` | 0 to 500 ms | 45 |
| `filter` | 150 to 12000 Hz | 4200 |
| `delay` | 0 to 70 | 18 |
| `reverb` | 0 to 80 | 28 |
| `output` | 0 to 100 | 65 |
| `mappings` | at most 64 objects | empty |

Numeric fields are clamped to the same ranges as the sliders in the UI. Numeric strings are converted; anything else takes the fallback.

Each mapping gets a `source` from the signal list in `SIGNAL_SPEC.md` (fallback `voice.brightness`), a `destination` from the destination list (fallback `synth.filterCutoff`), an `amount` clamped to -100 to 100, a `curve` of `linear`, `square` or `sqrt`, and `enabled` true unless it is exactly false. Mapping ids must match `[A-Za-z0-9_:-]{1,64}` and be unique; others become `map-N`.

## Storage

User presets live in localStorage under `voxctl.presets.v0.3`. Stored ids must match `user:` plus 1 to 16 lowercase letters or digits, the name must be a string of at most 64 characters, and the state must be an object; other entries are ignored. Every page on the same origin shares this storage, which on GitHub Pages means every project site of one account, so stored entries are validated rather than trusted.
