import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiManager, bendValue } from '../src/midi/midi-manager.js';

function withOutput() {
  const sent = [];
  const m = new MidiManager();
  m.output = { send: msg => sent.push(msg) };
  return { m, sent };
}

const kind = msg => msg[0] & 0xf0;

test('a re-struck held note becomes the latest note', () => {
  const m = new MidiManager();
  m.handleMessage([0x90, 60, 100]);
  m.handleMessage([0x90, 64, 100]);
  m.handleMessage([0x90, 60, 90]);
  assert.equal(m.getPerformanceState().note, 60);
  m.handleMessage([0x80, 60, 0]);
  assert.equal(m.getPerformanceState().note, 64);
});

test('pitch bend encodes the offset exactly within the +/-2 range', () => {
  assert.equal(bendValue(0), 8192);
  assert.equal(bendValue(2), 16383);
  assert.equal(bendValue(-2), 0);
  for (const st of [0.5, -0.4, 1.5, -1.25]) {
    const v = bendValue(st);
    const back = ((v - 8192) / (v < 8192 ? 8192 : 8191)) * 2;
    assert.ok(Math.abs(back - st) * 100 < 0.05, `${st} st`);
  }
});

test('a voice hovering at x.5 sends one note-on, then only bends', () => {
  const { m, sent } = withOutput();
  for (let i = 0; i < 100; i++) m.sendTheremin({ midi: 60.5 + 0.02 * Math.sin(i * 2.1), level: 0.6 });
  assert.equal(sent.filter(msg => kind(msg) === 0x90).length, 1);
  assert.equal(sent.filter(msg => kind(msg) === 0x80).length, 0);
});

test('a note change sends the bend before the note-on', () => {
  const { m, sent } = withOutput();
  m.sendTheremin({ midi: 60, level: 0.5 });
  sent.length = 0;
  m.sendTheremin({ midi: 64.3, level: 0.5 });
  const order = sent.map(kind).filter(k => k !== 0xb0);
  assert.deepEqual(order, [0x80, 0xe0, 0x90]);
  const bend = sent.find(msg => kind(msg) === 0xe0);
  assert.equal(bend[1] | (bend[2] << 7), bendValue(0.3));
});

test('loudness changes after the attack go out as CC11, only when they change', () => {
  const { m, sent } = withOutput();
  m.sendTheremin({ midi: 60, level: 0.5 });
  m.sendTheremin({ midi: 60, level: 0.5 });
  m.sendTheremin({ midi: 60, level: 0.9 });
  const cc = sent.filter(msg => kind(msg) === 0xb0);
  assert.deepEqual(cc.map(msg => [msg[1], msg[2]]), [[11, 64], [11, 114]]);
});

test('stopping releases the note and centers the bend', () => {
  const { m, sent } = withOutput();
  m.sendTheremin({ midi: 62, level: 0.5 });
  sent.length = 0;
  m.sendTheremin({ voiced: false });
  assert.deepEqual(sent, [[0x80, 62, 0], [0xe0, 0, 64]]);
  assert.equal(m.lastOutputNote, null);
});

test('an unplugged input is dropped along with its held notes', () => {
  const port = { id: 'in1', state: 'connected', onmidimessage: null };
  const inputs = new Map([['in1', port]]);
  const m = new MidiManager();
  m.access = { inputs, outputs: new Map() };
  m.setInput('in1');
  m.handleMessage([0x90, 60, 100]);
  port.state = 'disconnected';
  m.dropDisconnectedPorts();
  assert.equal(m.input, null);
  assert.equal(m.getPerformanceState().active, false);
  assert.deepEqual(m.getSelection(), { input: '', output: '' });
});
