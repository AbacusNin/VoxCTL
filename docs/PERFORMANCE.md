# Performance Model, v0.4.0

The v0.4.0 "Feel" controls, what each one does to the sound, and what each one costs. Every number here is a default or a limit in the code, or a measurement named where it appears.

## Pitch path

One McLeod detector reads a window every 30 ms. PitchTracker takes a 3-frame median, then either quantizes with its sticky hold or, in free mode, applies the optional free-mode hysteresis. The synth then glides once, on the audio clock. There is no separate stabilizer and no octave guard. The detector does not make octave errors on the test signals (see VALIDATION.md), and a guard would eat real leaps: the one in the v0.4 prototype held a sung 220 to 440 Hz leap at 220 Hz for all 1.8 s.

Free-mode hysteresis defaults to 0, which is off. At 14 cents a ±10 cent vibrato came out as one flat pitch, so the setting stays a choice. Its costs, when on:

- vibrato shallower than the setting disappears;
- a slow slide moves in steps of about the setting (15 cent steps at 14 cents, for a 100 cent per second glide);
- a voice that settles within the setting of the held pitch is output at the held pitch for as long as it stays there. At 14 cents, a voice 13 cents sharp held for 3 s came out at +0 cents.

The cap is 25 cents, a quarter of a semitone. Quantized mode is the tool for more.

## Tuning

A4 is set from 430 to 450 Hz in 0.1 Hz steps. It moves the oscillator's base frequency, and every MIDI number in the app is relative to it, so quantizing, custom cents scales, the note readout, the tuner and MIDI out all follow it. MIDI.md covers what that means for a receiving synth.

## Tuner

The tuner shows the gated detector pitch before the median, the hysteresis and quantizing, against the nearest equal-tempered semitone of the reference. It names the note it measures against, so +20 cents says which semitone it is sharp of. The needle turns green within 5 cents. It shows nothing while calibrating or when the voice is under the noise gate, and it keeps showing the voice while MIDI override plays or the feedback guard probes.

## Dynamics

The voice level is normalized above the noise gate, raised to the loudness curve exponent (0.25 to 2.5, default 0.72), and scheduled onto the synth gain with the attack time when it rises and the release time when it falls. Attack runs 1 to 500 ms (default 54) and release 5 to 2000 ms (default 105), both to about 95 percent. The defaults reproduce the time constants of v0.3.2 (18 ms for level changes, 35 ms at note end). The one audible difference from v0.3.2 is that a falling level while voiced now uses 35 ms instead of 18.

Release also slows a voice getting quieter, not only the note end. The feedback guard, calibration, a hidden tab and a stalled worklet never use the release: they mute with a fixed 35 ms constant. ARCHITECTURE.md explains why.

## Latency estimate

The panel sums the values the browser reports and two that VoxCTL knows:

| Part | Source |
|---|---|
| Mic input (track) | the capture track's `latency` setting, where the browser reports it |
| Pitch window (half) | window size / sample rate / 2: 21.3 ms for 2048 samples at 48 kHz |
| Analysis wait (half cadence) | half the smoothed gap between analysis frames, about 15 ms |
| Audio context | `AudioContext.baseLatency` |
| Output device | `AudioContext.outputLatency` |

A value the browser does not report shows as not reported, and a + after the total means the real figure is higher. Gaps of 250 ms or more (a hidden tab, a stall) do not enter the cadence. The glide, the attack and the one frame the pitch median adds to a note change are not counted. This is an estimate from reported values, not a measured acoustic round trip.

## Looper timing

The transport runs on the audio clock with a 120 ms lookahead. A take recorded to the grid starts its recorder 0.15 s before the downbeat and marks the start from the context time read just before `MediaRecorder.start()`. Measured in Chrome 152 at 48 kHz, that was 6.5 to 14.5 ms off, against 68 to 76 ms for a time read in `onstart`. A sung take also lags the click by the output path, the input path and the analysis. The looper adds an estimate of that (reported output, base and track latency, half the pitch window, half an analysis hop and 6 ms for the limiter) and the Loop offset nudge, -250 to 250 ms, to the take's start. Uncompensated, a loop would play roughly 60 to 100 ms behind the click on wired output, and more on Bluetooth.

Fitting a take to a different length changes its playback rate, so speed and pitch change together; the status line says by how many cents. This is a performance looper, not a time stretcher. Rates outside 0.5x to 2x are refused rather than clamped.

Takes record the synth only. The click, the count-in and loop playback are not recorded, so there is no overdub in v0.4.0. MediaRecorder cannot start sample-accurately, and each overdub pass would be re-encoded lossily.

## MIDI learn

A learned CC maps its 0 to 127 value onto the whole range of one slider, snapped to the slider's step, and applies it through the slider's own input event at most once every 16 ms. The slider jumps to the knob; there is no pickup. Bindings are saved in this browser and travel in a preset only when Include MIDI learn bindings is checked. MIDI.md has the details.
