// SPDX-License-Identifier: GPL-3.0-only
// Samples and wavetables: the records of SMPL, as the tracker keeps them.

import { concat } from './format.js';

// ---------------------------------------------------------------- samples and wavetables

// SMPL holds the records that operators with WAVE_SAMPLE or WAVE_TABLE
// point at by data_offset (console_sys.h: SampleHeader and its frames,
// WaveTable and its steps). The tracker keeps them as song.waves; while a
// song is open, such an operator's data_offset is the number of its wave in
// that list (NO_WAVE: none). Writing the song lays the waves out in SMPL
// and puts the offsets back.
export const WAVE_SAMPLE = 5, WAVE_TABLE = 6, OP_TABLE_SMOOTH = 16, NO_WAVE = 0xFFFFFFFF;
export const SAMPLE_FORMATS = ['16-bit', '8-bit', '4-bit'];
export const TABLE_SHAPES = ['sine', 'triangle', 'saw', 'square', 'noise'];
export const sampleBytes = (frames, format) => (format === 0 ? frames * 2 : format === 1 ? frames : format === 2 ? (frames + 1) >> 1 : -1);

// A wavetable's steps as a shape, or rounded to `bits` bits (the Game Boy's
// wave channel has 4, the PC Engine 5, the Konami SCC 8).
export function shapeTable(t, shape) {
  const n = t.steps.length;
  let seed = 1;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const v = shape === 'sine' ? Math.sin(2 * Math.PI * x) : shape === 'triangle' ? 1 - 4 * Math.abs(x - 0.5)
      : shape === 'saw' ? 2 * x - 1 : shape === 'square' ? (x < 0.5 ? 1 : -1)
      : ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
    t.steps[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
  }
}
export function quantizeTable(t, bits) {
  const levels = (1 << bits) - 1;
  for (let i = 0; i < t.steps.length; i++)
    t.steps[i] = Math.round(Math.round((t.steps[i] + 32767) / 65534 * levels) / levels * 65534 - 32767);
}
export function newTable(length = 32, shape = 'sine') {
  const t = { kind: 'table', name: '', steps: new Int16Array(Math.max(2, Math.min(1024, length | 0))) };
  shapeTable(t, shape);
  return t;
}
export function setTableLength(t, length) {
  const old = t.steps, n = Math.max(2, Math.min(1024, length | 0));
  t.steps = Int16Array.from({ length: n }, (_, i) => old[Math.floor(i * old.length / n)]);
}
// A sample from mono float frames (a decoded sound file), 16-bit.
export function newSample(floats, rate, root = 60) {
  const data = new Uint8Array(floats.length * 2), dv = new DataView(data.buffer);
  floats.forEach((v, i) => dv.setInt16(i * 2, Math.max(-32767, Math.min(32767, Math.round(v * 32767))), true));
  return { kind: 'sample', name: '', frames: floats.length, loopStart: 0, loopLength: 0, rate: Math.round(rate), root, format: 0, data };
}
// A sample's frame k as -1..1 (for drawing it).
export function sampleFrame(w, k) {
  const d = w.data;
  if (w.format === 0) { const v = d[2 * k] | d[2 * k + 1] << 8; return (v >= 0x8000 ? v - 0x10000 : v) / 32768; }
  if (w.format === 1) return (d[k] >= 0x80 ? d[k] - 0x100 : d[k]) / 128;
  if (w.format === 2) { const b = d[k >> 1], v = k & 1 ? b >> 4 : b & 15; return (v >= 8 ? v - 16 : v) / 8; }
  return 0;
}

// Read SMPL into waves; each referring operator's data_offset becomes the
// number of its wave (NO_WAVE if it points nowhere useful). `list` (the
// tracker's own, from xTRK) names every wave written, used or not, by
// its offset: they come first, in that order, with their names.
export function readWaves(instruments, smpl, list = []) {
  const waves = [], at = new Map(), size = smpl ? smpl.length : 0;
  const dv = smpl ? new DataView(smpl.buffer, smpl.byteOffset, smpl.byteLength) : null;
  const refs = [];
  for (const ins of instruments) for (let o = 0; o < 4; o++) {
    const w = ins.bytes[o * 20];
    if (w === WAVE_SAMPLE || w === WAVE_TABLE) refs.push(getU32(ins.bytes, o * 20 + 16));
  }
  for (const it of Array.isArray(list) ? list : []) if (it) refs.push(it.at >>> 0);
  const starts = [...new Set(refs)].sort((a, b) => a - b);
  const decode = (wave, off) => {
    if (!dv || off % 4) return null;
    if (wave === WAVE_TABLE) {
      if (off + 4 > size) return null;
      const n = dv.getUint16(off, true);
      if (n < 2 || n > 1024 || off + 4 + 2 * n > size) return null;
      return { kind: 'table', name: '', steps: Int16Array.from({ length: n }, (_, i) => dv.getInt16(off + 4 + 2 * i, true)) };
    }
    if (off + 20 > size) return null;
    const w = { kind: 'sample', name: '', frames: dv.getUint32(off, true), loopStart: dv.getUint32(off + 4, true),
      loopLength: dv.getUint32(off + 8, true), rate: dv.getUint32(off + 12, true), root: smpl[off + 16], format: smpl[off + 17] };
    let n = sampleBytes(w.frames, w.format);
    if (n < 0) n = (starts.find((x) => x > off) || size) - off - 20;     // an unknown format: up to the next record
    w.data = smpl.slice(off + 20, Math.min(size, off + 20 + n));
    return w;
  };
  for (const it of Array.isArray(list) ? list : []) {
    const w = it && it.kind === 'table' ? WAVE_TABLE : it && it.kind === 'sample' ? WAVE_SAMPLE : 0, key = w + ':' + (it && it.at);
    if (!w || at.has(key)) continue;
    const r = decode(w, it.at >>> 0);
    if (r) { r.name = String(it.name || ''); at.set(key, waves.push(r) - 1); }
  }
  for (const ins of instruments) for (let o = 0; o < 4; o++) {
    const w = ins.bytes[o * 20];
    if (w !== WAVE_SAMPLE && w !== WAVE_TABLE) continue;
    const off = getU32(ins.bytes, o * 20 + 16), key = w + ':' + off;
    if (!at.has(key)) { const r = decode(w, off); at.set(key, r ? waves.push(r) - 1 : NO_WAVE); }
    setU32(ins.bytes, o * 20 + 16, at.get(key));
  }
  return waves;
}

// SMPL for the waves, and the instruments with real offsets. An operator
// whose wave is missing or of the other kind gets a plain one (a sine
// table, a silent sample), so the song still loads.
export function writeWaves(song) {
  const waves = song.waves.slice(), bytes = song.instruments.map((i) => i.bytes.slice());
  let plainTable = -1, plainSample = -1;
  for (const b of bytes) for (let o = 0; o < 4; o++) {
    const kind = b[o * 20] === WAVE_TABLE ? 'table' : b[o * 20] === WAVE_SAMPLE ? 'sample' : null;
    if (!kind) { setU32(b, o * 20 + 16, 0); continue; }
    const k = getU32(b, o * 20 + 16);
    if (waves[k] && waves[k].kind === kind) continue;
    if (kind === 'table') { if (plainTable < 0) plainTable = waves.push(newTable()) - 1; setU32(b, o * 20 + 16, plainTable); }
    else { if (plainSample < 0) plainSample = waves.push(newSample([0], 8000)) - 1; setU32(b, o * 20 + 16, plainSample); }
  }
  const parts = [], offs = [];
  let at = 0;
  for (const w of waves) {
    let rec;
    if (w.kind === 'table') {
      rec = new Uint8Array(4 + 2 * w.steps.length);
      const dv = new DataView(rec.buffer);
      dv.setUint16(0, w.steps.length, true);
      w.steps.forEach((v, i) => dv.setInt16(4 + 2 * i, v, true));
    } else {
      rec = new Uint8Array(20 + w.data.length);
      const dv = new DataView(rec.buffer);
      [w.frames, w.loopStart, w.loopLength, w.rate].forEach((v, i) => dv.setUint32(4 * i, v >>> 0, true));
      rec[16] = w.root; rec[17] = w.format;
      rec.set(w.data, 20);
    }
    offs.push(at);
    const padded = new Uint8Array(rec.length + (-rec.length & 3));
    padded.set(rec);
    parts.push(padded);
    at += padded.length;
  }
  for (const b of bytes) for (let o = 0; o < 4; o++)
    if (b[o * 20] === WAVE_TABLE || b[o * 20] === WAVE_SAMPLE) setU32(b, o * 20 + 16, offs[getU32(b, o * 20 + 16)]);
  return { smpl: at ? concat(parts) : null, inst: concat(bytes), list: waves.map((w, i) => ({ at: offs[i], kind: w.kind, name: w.name })) };
}
export const getU32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
export const setU32 = (b, o, v) => { b[o] = v & 0xFF; b[o + 1] = (v >>> 8) & 0xFF; b[o + 2] = (v >>> 16) & 0xFF; b[o + 3] = v >>> 24; };
// The instruments and operators that use wave k.
export function waveUsers(song, k) {
  const out = [];
  song.instruments.forEach((ins, i) => { for (let o = 0; o < 4; o++) {
    const w = ins.bytes[o * 20];
    if ((w === WAVE_TABLE || w === WAVE_SAMPLE) && getU32(ins.bytes, o * 20 + 16) === k) out.push([i, o]);
  } });
  return out;
}
