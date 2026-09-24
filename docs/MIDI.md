# MIDI, v0.4.0

Web MIDI is optional and activated only on explicit user action. Access is requested without SysEx.

## Input

The selected input tracks note-on, note-off and pitch bend. When **MIDI note + pitch bend override synth pitch** is enabled, the most recently struck held note becomes the oscillator pitch source. Re-striking a note that is already held makes it the current note again. Velocity sets the synth voice level. Pitch bend is read as ±2 semitones.

Keys and bends are played as they arrive, not at the next voice-analysis frame. The Glide setting still applies between notes, and the Attack and Release settings shape the key's level. When the last key is released the synth goes quiet at the release time, and the voice takes over pitch again. While calibration runs, MIDI input does not play.

CC 120 (All Sound Off) and CC 123 (All Notes Off), which a controller's panic button sends, release every held key, so override lets go.

Control change messages never affect override. Before v0.4.0 a CC with override on and no key held muted the voice and made MIDI out send a note-off and then a new note-on; with a learned knob every message of a sweep would have done that.

Voice-derived spectral features and the mapping matrix keep running while MIDI controls pitch, which allows hybrid control such as MIDI pitch plus vocal brightness to filter. A detune mapping therefore also bends MIDI-driven pitch. The feedback guard is off while MIDI drives pitch, because output then does not follow the mic.

If the selected input or output is unplugged, it is released: held notes and bend are cleared, and the selector shows None.

## Output

When **Send theremin pitch to MIDI output** is enabled, the pitch the synth is actually playing (including detune from mappings and plugins) goes out on channel 1 as:

1. a note-on for the nearest note, sent after the pitch bend for the new note so the note does not start at the old bend,
2. 14-bit pitch bend for the distance from that note, updated only when it changes,
3. CC11 (expression) for the voice level, updated only when it changes. Velocity covers only the attack.

The note is held while the pitch stays within 1.5 semitones of it, and the difference is carried in pitch bend. A new note (note-off, bend, note-on) is sent only when the pitch moves further than that. This keeps a voice hovering between two notes from sending a stream of note-ons.

The receiver must use a ±2-semitone pitch-bend range, which is the MIDI 1.0 default. On silence, on a hidden tab, during calibration, while the feedback guard mutes the synth and on page close, the app sends note-off and re-centers the bend.

Velocity and CC11 follow the voice level linearly. The Loudness curve shapes only the synth's own gain.

## A4 reference

MIDI in and out are in reference space: note 69 is A4 at the Reference A4 setting, and pitch bend carries only the cents left over. Set the receiving synth's master tune to the same reference.

If the receiver stays at 440 Hz, quantized notes land on its 440-tuned pitches, and free mode is off by the ratio of the two references. With the reference at 432, a sung 440 Hz goes out as note 69 plus a 31.8 cent bend, and a 440 receiver plays about 448 Hz. Sending 440-space notes instead would put a constant bend on every quantized note, so reference space wins.

Changing the reference while a note sounds does not retrigger MIDI out. A 128-step sweep from 430 to 450 Hz over a held voice sent one note-on and then only bends.

## MIDI learn

Pick a control under **Learn target**, press **Learn CC**, and move a knob or fader. The next CC from 0 to 119 on the selected input binds to that control. The arm times out after 15 s, and pressing the button again cancels it. CCs 120 to 127 are channel mode messages; they never bind, and an armed learn stays armed when one arrives.

Learnable controls:

- Performance: Quantize strength, Glide, Reference A4, Free-mode hysteresis
- Synth: Filter cutoff, Delay, Reverb, Output, Attack, Release, Loudness curve
- Looper: Loop level, Click level
- every slider of a loaded plugin, named `plugin:<plugin id>:<control id>`

A binding to a plugin control does nothing while that plugin is not loaded, and its chip says so. Mapping-matrix amounts are number fields, not sliders, and cannot be learned.

A learned CC sets the whole range of its slider, snapped to the slider's step, and the slider jumps to the knob on the first message; there is no pickup. Matching is omni: a binding answers its CC number on any channel. The value goes through the slider's own `input` event, the same path as a hand drag, at most once per slider every 16 ms. One CC drives one control and one control has one CC; learning either again replaces the old binding. At most 32 bindings are kept.

Bindings are saved in this browser under `voxctl.midiLearn.v0.4` and checked on every read (see `SECURITY.md`). If storage is blocked, a binding lasts for the session and the status line says so. Presets carry bindings only when **Include MIDI learn bindings** is checked, for saving and for loading (see `PRESET_FORMAT.md`).

VoxCTL sends CC11 on MIDI out. If you learn CC11 while MIDI out is on and that output loops back to the selected input, the slider will follow your voice. The status line warns about this when it happens.
