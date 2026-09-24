# Security Notes, v0.3.2

## Core principles

- Core instrument operation requires no backend or API key.
- Microphone permission is requested only after the user starts the instrument.
- Web MIDI permission is requested only after the user chooses Connect MIDI, without SysEx.
- Room calibration and user presets are stored locally in browser storage.
- Master-bus recording captures generated synth output, not the raw microphone track.
- The continuous theremin path never sends audio anywhere.

## Speech commands and privacy

Spoken commands are optional and off by default. While they are on, the browser streams microphone audio to its speech service: Chrome sends it to Google's servers and Edge sends it to Microsoft's. The page says so next to the toggle. The theremin audio path is separate and stays on the device.

If recognition fails with an error that would recur (permission denied, service not allowed, no audio device, network, unsupported language), the app stops it and unchecks the toggle instead of restarting.

## Page hardening

index.html carries a meta Content-Security-Policy:

- script-src allows only the page's origin plus the sha256 hashes of the sandbox runtime and each bundled isolated plugin. Neither unsafe-inline nor unsafe-eval is allowed.
- style-src, connect-src, worker-src and manifest-src are the page's origin; img-src adds data:, and media-src adds blob: so recorded takes can play.
- frame-src is the page's origin, object-src is none, base-uri is none and form-action is none.

A meta CSP cannot set frame-ancestors, and GitHub Pages cannot send custom headers. The app therefore refuses to run when it is framed by another page, showing only a message, so a hostile site cannot overlay Start, Record or Connect MIDI.

Every string that app.js writes into markup (preset names and ids, mapping fields, MIDI port names, plugin manifest fields) is escaped.

## Plugin model

### Trusted modules

Only manifests on a fixed allowlist run as same-realm ES modules; in this release that is the bundled Ghost Radio plugin. Capability objects reduce accidental coupling, but same-realm JavaScript is trusted code and can reach any page API. A manifest that is not on the allowlist and asks for trusted execution is refused.

### Isolated control plugins

Every other plugin runs in a separate sandboxed iframe realm with:

- an opaque origin (`allow-same-origin` is omitted), and scripts as the only sandbox capability,
- a frame CSP of `default-src 'none'` that allows only the hashed runtime and plugin scripts, on top of the inherited page CSP,
- source and manifest fetched only from the page's own origin,
- a private MessageChannel port as the only link to the host, handed over on the frame's first load,
- unloading on any later load of the frame,
- manifest permission checks, the host capability allowlist, and host-side clamping of every value,
- a master gain offset that can only lower the output,
- only `{ voiced }` in each signal unless the manifest asks for voice.features.read,
- coalescing to one update per capability every 16 ms, and unloading above 400 messages per second.

The host renders plugin UI itself and sends parameter values inward. The plugin cannot modify the host DOM or storage.

Because the page CSP must list each isolated plugin's hash, only plugins bundled with the release can run. Loading an arbitrary third-party plugin would mean adding its hash to index.html, which is a code review decision.

## What the sandbox does not stop

The sandbox limits hostile JavaScript but does not fully contain it:

- An isolated plugin can still navigate its own frame to a page on this origin, which sends that one request before the host unloads the plugin on the frame's next load. Navigation to another origin is blocked by the page's frame-src 'self'; in Chromium a sandboxed frame's own redirect to another origin was refused with a frame-src violation.
- An isolated plugin can still use WebRTC; CSP does not govern ICE and STUN traffic in current browsers. A plugin with voice.features.read could send the pitch, level and formant track that way.
- A sandboxed iframe can still consume CPU and degrade the tab, and in browsers that run it on the page's thread, freeze the UI until the message limit unloads it.
- Browser-engine vulnerabilities are outside the application threat model.
- Isolated plugins cannot contribute AudioWorklet or DSP code.
- Trusted plugins are trusted code, not sandboxed code.
- Browser storage is shared with every page on the origin. On GitHub Pages that is every project site of one account, so stored presets and calibration are validated on every read rather than trusted.
- Preset JSON is data and is validated, but treat files from unknown sources with care.

## Feedback safety

Use headphones. The app turns off browser noise suppression, automatic gain and echo cancellation where supported, to keep the voice analysis musical, and synth output follows mic loudness. On speakers that loop can sustain itself.

A feedback guard catches most loops. After 3 s of unbroken voice it mutes the synth for 300 ms and watches the lowest mic level across that probe. A singer keeps going through the gap; a speaker loop loses its source. If the level falls below 30% of the level before the probe, the guard keeps the synth and MIDI output muted and shows a warning until the mic has been quiet for 1 s. Probes are at least 20 s apart, and the guard resets when the tab is hidden or MIDI override is toggled. It is off while MIDI input drives pitch.

The guard cannot catch loop playback of a recorded take, because muting the synth leaves the take playing. The UI says so next to the loop toggle.

A limiter before the destination keeps the summed dry, delay and reverb paths from clipping at high settings, in the speakers and in recordings.
