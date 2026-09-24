# MIDI, v0.3.1

Web MIDI is optional and activated only on explicit user action. Access is requested without SysEx.

## Input

The selected input tracks note-on, note-off and pitch bend. When **MIDI note + pitch bend override synth pitch** is enabled, the most recently struck held note becomes the oscillator pitch source. Re-striking a note that is already held makes it the current note again. Velocity sets the synth voice level. Pitch bend is read as ±2 semitones.

Keys and bends are played as they arrive, not at the next voice-analysis frame. The Glide setting still applies between notes. When the last key is released the synth goes quiet, and the voice takes over pitch again. While calibration runs, MIDI input does not play.

Voice-derived spectral features and the mapping matrix keep running while MIDI controls pitch, which allows hybrid control such as MIDI pitch plus vocal brightness to filter. A detune mapping therefore also bends MIDI-driven pitch. The feedback guard is off while MIDI drives pitch, because output then does not follow the mic.

If the selected input or output is unplugged, it is released: held notes and bend are cleared, and the selector shows None.

## Output

When **Send theremin pitch to MIDI output** is enabled, the pitch the synth is actually playing (including detune from mappings and plugins) goes out on channel 1 as:

1. a note-on for the nearest note, sent after the pitch bend for the new note so the note does not start at the old bend,
2. 14-bit pitch bend for the distance from that note, updated only when it changes,
3. CC11 (expression) for the voice level, updated only when it changes. Velocity covers only the attack.

The note is held while the pitch stays within 1.5 semitones of it, and the difference is carried in pitch bend. A new note (note-off, bend, note-on) is sent only when the pitch moves further than that. This keeps a voice hovering between two notes from sending a stream of note-ons.

The receiver must use a ±2-semitone pitch-bend range, which is the MIDI 1.0 default. On silence, on a hidden tab, during calibration, while the feedback guard mutes the synth and on page close, the app sends note-off and re-centers the bend.
