// Receivers are assumed to use the default +/-2 semitone pitch-bend range.
const BEND_RANGE = 2;
// Hold the sounding note and bend while the voice stays within this many
// semitones of it. Retriggering on every rounded-note change sent a note-on
// storm when the voice hovered near x.5.
const HOLD_RANGE = 1.5;

export class MidiManager {
  constructor({ onInput } = {}) {
    this.access = null;
    this.input = null;
    this.output = null;
    this.onInput = onInput || (() => {});
    this.activeNotes = new Map();
    this.pitchBend = 0;
    this.lastOutputNote = null;
    this.lastBend = null;
    this.lastExpression = null;
  }

  async connect() {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not supported by this browser.');
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => {
        this.dropDisconnectedPorts();
        this.onInput({ type: 'ports-changed' });
      };
    }
    return this.getPorts();
  }

  // An unplugged port stays referenced otherwise, so held notes kept
  // overriding pitch while the UI showed no input selected.
  dropDisconnectedPorts() {
    if (this.input && this.access?.inputs.get(this.input.id)?.state !== 'connected') this.setInput(null);
    if (this.output && this.access?.outputs.get(this.output.id)?.state !== 'connected') {
      this.output = null;
      this.lastOutputNote = null;
      this.lastBend = null;
      this.lastExpression = null;
    }
  }

  getPorts() {
    return {
      inputs: this.access ? [...this.access.inputs.values()].map(portInfo) : [],
      outputs: this.access ? [...this.access.outputs.values()].map(portInfo) : []
    };
  }

  getSelection() {
    return { input: this.input?.id || '', output: this.output?.id || '' };
  }

  setInput(id) {
    if (this.input) this.input.onmidimessage = null;
    this.input = id && this.access ? this.access.inputs.get(id) || null : null;
    this.activeNotes.clear();
    this.pitchBend = 0;
    if (this.input) this.input.onmidimessage = event => this.handleMessage(event.data);
  }

  setOutput(id) {
    this.stopOutput();
    this.output = id && this.access ? this.access.outputs.get(id) || null : null;
  }

  handleMessage(data) {
    const [statusByte = 0, data1 = 0, data2 = 0] = data;
    const status = statusByte & 0xf0;
    if (status === 0x90 && data2 > 0) {
      // Map keeps first-insertion order, so a re-struck held note has to be
      // removed first to become the latest note again.
      this.activeNotes.delete(data1);
      this.activeNotes.set(data1, data2);
      this.emitState('note');
    } else if (status === 0x80 || (status === 0x90 && data2 === 0)) {
      this.activeNotes.delete(data1);
      this.emitState('note');
    } else if (status === 0xe0) {
      const raw = (data2 << 7) | data1;
      this.pitchBend = Math.max(-1, Math.min(1, (raw - 8192) / 8192));
      this.emitState('bend');
    } else if (status === 0xb0) {
      // All Sound Off and All Notes Off, from a controller's panic button,
      // release held keys so MIDI override lets go.
      if ((data1 === 120 || data1 === 123) && this.activeNotes.size) {
        this.activeNotes.clear();
        this.emitState('note');
      }
      this.onInput({ type: 'cc', controller: data1, value: data2 / 127, state: this.getPerformanceState() });
    }
  }

  getPerformanceState() {
    const notes = [...this.activeNotes.entries()];
    const [note, velocity] = notes.length ? notes[notes.length - 1] : [null, 0];
    return {
      active: note !== null,
      note,
      velocity: velocity / 127,
      pitchBend: this.pitchBend,
      midi: note === null ? null : note + this.pitchBend * BEND_RANGE
    };
  }

  emitState(reason) { this.onInput({ type: reason, state: this.getPerformanceState() }); }

  sendTheremin({ midi, level = 0.7, voiced = true } = {}) {
    if (!this.output) return;
    if (!voiced || !Number.isFinite(midi)) {
      this.stopOutput();
      return;
    }
    const target = Math.max(0, Math.min(127, midi));
    const retrigger = this.lastOutputNote === null || Math.abs(target - this.lastOutputNote) > HOLD_RANGE;
    const note = retrigger ? Math.round(target) : this.lastOutputNote;
    const bend14 = bendValue(target - note);

    if (retrigger) {
      if (this.lastOutputNote !== null) this.output.send([0x80, this.lastOutputNote, 0]);
      // Bend before note-on, so the new note does not start at the old bend.
      this.output.send([0xe0, bend14 & 0x7f, (bend14 >> 7) & 0x7f]);
      this.output.send([0x90, note, Math.max(1, Math.min(127, Math.round(level * 127)))]);
      this.lastOutputNote = note;
    } else if (bend14 !== this.lastBend) {
      this.output.send([0xe0, bend14 & 0x7f, (bend14 >> 7) & 0x7f]);
    }
    this.lastBend = bend14;

    // Velocity only covers the attack; CC11 (expression) carries the voice's
    // swells after it. Sent only on a change so a steady voice is quiet.
    const expression = Math.max(0, Math.min(127, Math.round(level * 127)));
    if (expression !== this.lastExpression) {
      this.output.send([0xb0, 11, expression]);
      this.lastExpression = expression;
    }
  }

  stopOutput() {
    if (this.output && this.lastOutputNote !== null) {
      this.output.send([0x80, this.lastOutputNote, 0]);
      this.output.send([0xe0, 0, 64]);
    }
    this.lastOutputNote = null;
    this.lastBend = null;
    this.lastExpression = null;
  }
}

// 14-bit pitch-bend value for an offset in semitones, centered on 8192.
export function bendValue(semitones) {
  const x = Math.max(-1, Math.min(1, semitones / BEND_RANGE));
  return Math.round(8192 + x * (x < 0 ? 8192 : 8191));
}

function portInfo(port) {
  return { id: port.id, name: port.name || 'Unnamed MIDI port', manufacturer: port.manufacturer || '', state: port.state };
}
