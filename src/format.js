// SPDX-License-Identifier: GPL-3.0-only
// The song commands, the chunk container (the RetCon chunk container), the
// Instrument layout and its fields, and names for notes and commands.

// ---------------------------------------------------------------- the song commands

export const CH = { END: 0, NOTE: 1, OFF: 2, INSTRUMENT: 3, VOLUME: 4, LENGTH: 5, LEGATO: 6, SLIDE_TO: 7,
  PITCH_SLIDE: 8, VIBRATO: 9, VOLUME_SLIDE: 10, POSITION: 11, FINE: 12, TEMPO: 13, MARKER: 14,
  CALL: 15, RETURN: 16, JUMP: 17, WAIT16: 18, BEND: 19, PATCH: 20, LOOP: 21, LOOP_END: 22,
  SWEEP: 23, CALL16: 24, ARPEGGIO: 25, SAMPLE_START: 26, WAIT: 0x80 };
export const ARG_BYTES = [0, 1, 0, 1, 1, 2, 1, 3, 2, 3, 1, 2, 1, 2, 1, 4, 0, 4, 2, 2, 2, 1, 0, 8, 2, -1, 2];
export const COMMAND_NAMES = ['END', 'NOTE', 'OFF', 'INSTRUMENT', 'VOLUME', 'LENGTH', 'LEGATO', 'SLIDE_TO',
  'PITCH_SLIDE', 'VIBRATO', 'VOLUME_SLIDE', 'POSITION', 'FINE', 'TEMPO', 'MARKER', 'CALL', 'RETURN',
  'JUMP', 'WAIT16', 'BEND', 'PATCH', 'LOOP', 'LOOP_END', 'SWEEP', 'CALL16', 'ARPEGGIO', 'SAMPLE_START'];
export const SONG_MAGIC = 0x31475352, SONG_VERSION = 1, SONG_DATA_VERSION = 2, INSTRUMENT_SIZE = 112;
export const NO_LOOP = 0xFFFFFFFF;

// The effect column: a letter and a byte, as in classic trackers.
//   0xy arpeggio (note, +x, +y semitones, one step a tick)
//   1xx / 2xx pitch slide up / down, xx cents a tick
//   3xx slide to the row's note, xx cents a tick
//   4xy vibrato, depth x * 8 cents, rate y Hz
//   Axy volume slide, up x or down y a tick
//   Fxx tempo, xx beats a minute
// Effects 0, 1, 2, 4 and A last for their row; the next row without the
// same effect stops it. 3 runs until the slide arrives; F stays.
export const FX_LETTERS = '0123456789ABCDEF';
export const FX_KINDS = { 0: 'arp', 1: 'slide', 2: 'slide', 4: 'vib', 10: 'vslide' };

// ---------------------------------------------------------------- the container

export const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export const td = new TextDecoder(), te = new TextEncoder();

export function readContainer(buf, magic) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 16 || td.decode(b.subarray(0, 4)) !== magic) throw new Error('not a RetCon song file');
  if (dv.getUint16(4, true) !== 1) throw new Error('unknown container version');
  const headerSize = dv.getUint32(8, true);
  if (headerSize < 16 || headerSize % 4 || headerSize > b.length) throw new Error('damaged container');
  const chunks = [];
  let at = headerSize;
  for (;;) {
    if (at + 12 > b.length) throw new Error('the file is cut off');
    const tag = td.decode(b.subarray(at, at + 4)), len = dv.getUint32(at + 4, true);
    const padded = len + (-len & 3);
    if (at + 12 + padded > b.length) throw new Error('a chunk runs past the end');
    if (crc32(b.subarray(at, at + 8 + len)) !== dv.getUint32(at + 8 + padded, true))
      throw new Error(`the ${tag} chunk is damaged (CRC)`);
    if (tag === 'END ') break;
    chunks.push({ tag, data: b.slice(at + 8, at + 8 + len) });
    at += 12 + padded;
  }
  return chunks;
}

export function writeContainer(magic, chunks) {
  let size = 16;
  for (const c of chunks) size += 12 + c.data.length + (-c.data.length & 3);
  size += 12;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out.set(te.encode(magic), 0);
  dv.setUint16(4, 1, true);
  dv.setUint32(8, 16, true);
  let at = 16;
  for (const c of [...chunks, { tag: 'END ', data: new Uint8Array(0) }]) {
    out.set(te.encode(c.tag), at);
    dv.setUint32(at + 4, c.data.length, true);
    out.set(c.data, at + 8);
    dv.setUint32(at + 8 + c.data.length + (-c.data.length & 3), crc32(out.subarray(at, at + 8 + c.data.length)), true);
    at += 12 + c.data.length + (-c.data.length & 3);
  }
  return out;
}

// ---------------------------------------------------------------- instruments

// Instrument layout (console_sys.h): 4 Operators of 20 bytes, then the rest.
export const OP_FIELDS = [
  ['wave', 0, 'u8'], ['ratio', 1, 'u8'], ['detune', 2, 'i8'], ['level', 3, 'u8'], ['width', 4, 'u16'],
  ['flags', 6, 'u8'], ['feedback', 7, 'u8'], ['sustain_decay', 8, 'u8'],
  ['attack', 12, 'u8'], ['decay', 13, 'u8'], ['sustain', 14, 'u8'], ['release', 15, 'u8']];
export const INST_FIELDS = [
  ['algorithm', 80, 'u8'], ['filter_mode', 81, 'u8'], ['cutoff', 82, 'u8'], ['resonance', 83, 'u8'],
  ['filter_env_amount', 84, 'i8'], ['glide', 85, 'u8'],
  ['filter_attack', 88, 'u8'], ['filter_decay', 89, 'u8'], ['filter_sustain', 90, 'u8'], ['filter_release', 91, 'u8'],
  ['lfo1_wave', 92, 'u8'], ['lfo1_target', 93, 'u8'], ['lfo1_rate', 94, 'u8'], ['lfo1_depth', 95, 'u8'], ['lfo1_delay', 96, 'u8'],
  ['lfo2_wave', 100, 'u8'], ['lfo2_target', 101, 'u8'], ['lfo2_rate', 102, 'u8'], ['lfo2_depth', 103, 'u8'], ['lfo2_delay', 104, 'u8']];
export const WAVES = ['sine', 'triangle', 'saw', 'pulse', 'noise', 'sample', 'wavetable', 'half sine', 'abs sine',
  'quarter sine', 'alt sine', 'camel sine'];
export const FILTERS = ['off', 'lowpass', 'highpass', 'bandpass', 'notch'];

export function getField(bytes, off, type) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return type === 'u8' ? dv.getUint8(off) : type === 'i8' ? dv.getInt8(off) : dv.getUint16(off, true);
}

export function setField(bytes, off, type, v) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === 'u8') dv.setUint8(off, Math.max(0, Math.min(255, v | 0)));
  else if (type === 'i8') dv.setInt8(off, Math.max(-128, Math.min(127, v | 0)));
  else dv.setUint16(off, Math.max(0, Math.min(65535, v | 0)), true);
}

// envelope byte <-> ms (synth.c: 1 ms * 10^(v/64))
export const envMs = (v) => (v === 0 ? 0 : Math.pow(10, v / 64));
export const msEnv = (ms) => (ms <= 1 ? 0 : Math.max(0, Math.min(255, Math.round(64 * Math.log10(ms)))));

// A one-operator instrument (operator 1 sounding, as the converters do).
export function makeInstrument({ wave = 3, level = 220, width = null, ratio = 2, attack = 2, decay = 300, sustain = 160,
                          release = 200, filter = 0, cutoff = 255, resonance = 0 } = {}) {
  const b = new Uint8Array(INSTRUMENT_SIZE), o = 20;
  setField(b, o + 0, 'u8', wave);
  setField(b, o + 1, 'u8', ratio);
  setField(b, o + 3, 'u8', level);
  setField(b, o + 4, 'u16', width === null ? (wave === 3 ? 32768 : 0) : width);
  setField(b, o + 12, 'u8', msEnv(attack));
  setField(b, o + 13, 'u8', msEnv(decay));
  setField(b, o + 14, 'u8', sustain);
  setField(b, o + 15, 'u8', msEnv(release));
  setField(b, 80, 'u8', 7);
  setField(b, 81, 'u8', filter);
  setField(b, 82, 'u8', cutoff);
  setField(b, 83, 'u8', resonance);
  return b;
}

export function defaultInstruments() {
  return [
    { name: 'Square', bytes: makeInstrument({ wave: 3 }) },
    { name: 'Thin pulse', bytes: makeInstrument({ wave: 3, width: 52000, decay: 500, sustain: 120 }) },
    { name: 'Saw bass', bytes: makeInstrument({ wave: 2, decay: 250, sustain: 180, release: 80, filter: 1, cutoff: 150, resonance: 90 }) },
    { name: 'Triangle', bytes: makeInstrument({ wave: 1, level: 255, decay: 400, sustain: 200 }) },
    { name: 'Sine pad', bytes: makeInstrument({ wave: 0, attack: 250, decay: 600, sustain: 200, release: 700 }) },
    { name: 'Noise hat', bytes: makeInstrument({ wave: 4, ratio: 32, level: 180, attack: 1, decay: 60, sustain: 0, release: 40 }) },
    { name: 'Noise snare', bytes: makeInstrument({ wave: 4, ratio: 24, level: 220, attack: 1, decay: 160, sustain: 0, release: 120 }) },
  ];
}


export function concat(arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
}

// ---------------------------------------------------------------- names
export const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export const noteName = (n) => NOTE_NAMES[n % 12] + (n < 12 ? '-' : Math.floor(n / 12) - 1);
export const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');

export function rawName(r) {
  const name = COMMAND_NAMES[r[0]] || 'cmd ' + r[0];
  return name + (r.length > 1 ? ' ' + Array.from(r.subarray(1), hex2).join(' ') : '');
}
