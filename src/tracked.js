// SPDX-License-Identifier: GPL-3.0-only
// Scream Tracker 3 (.s3m), FastTracker 2 (.xm) and Impulse Tracker (.it)
// modules: read into one form, then opened like a ProTracker module (mod.js): best effort keeps the
// module's patterns and order, its effects on the effect column where there
// is one; exact import plays it tick by tick and lays that on one tick a row.

import { CH, INSTRUMENT_SIZE } from './format.js';
import { WAVE_SAMPLE, setU32 } from './waves.js';
import { bestEffort, cellEmpty, emptyCell, newPattern } from './song.js';
import { MOD_PAN, MOD_ROOT_PERIOD, MOD_SINE, OP_SAMPLE_NEAREST, PAL_CLOCK, modExact, modNote, modPatterns, modVolume, readModFile } from './mod.js';

// ---------------------------------------------------------------- the common form
//
// { kind: 's3m' | 'xm' | 'it', name, nch, order, pats: [{ rows, cells[row][ch] }],
//   samples: [{ name, frames, bits, data (Uint8Array, PCM as the song keeps it),
//     loopStart, loopLength, volume 0-64, pan 0-255 | null, c5 (s3m, it) | relnote, finetune (xm) }],
//   instruments: [{ name, map[96] -> sample index | -1, env, panEnv, fadeout (of 65536 a tick) }] (xm, it; else one per sample),
//   speed, tempo, globalVolume 0-64, linear, fastSlides, pans[ch] 0-255, chanVols[ch] 0-64 (it), notes: [...] }
// A cell: { note: MIDI | 'off' | null, inst: 1-based | 0, vol: 0-64 | null, volfx: XM volume column | 0, fx, prm }
// Effects are XM's (0x0-0xF as in ProTracker), plus TM.SPEED and TM.TEMPO for
// Fxx split by its value, TM.BREAK for Dxx with its row in decimal, and XM's
// letters: G 16, H 17, K 20, L 21, P 25, R 27, T 29, X 33.
export const TM = { SPEED: 0x40, TEMPO: 0x41, BREAK: 0x42, G: 16, H: 17, K: 20, L: 21, P: 25, R: 27, T: 29, X: 33 };
const TM_NONE = -1;

// ---------------------------------------------------------------- Scream Tracker 3 (.s3m)

// An S3M or IT effect (its command letter, A 1 to Z 26) as the common form's,
// noting in `notes` what has none. `it`: Impulse Tracker's differences
// (a break row in hex, global volume 0-128, panning 0-255, W, P, M, N, Y, Z).
function tmEffect(cmd, prm, notes, it) {
  const x = prm >> 4, y = prm & 15;
  switch (String.fromCharCode(64 + cmd)) {
    case 'A': return prm ? [TM.SPEED, prm] : [TM_NONE, 0];
    case 'B': return [0xB, prm];
    case 'C': return [TM.BREAK, it ? prm : x * 10 + y];
    case 'D': if (x === 15 && y) return [0xE, 0xB0 | y]; if (y === 15 && x) return [0xE, 0xA0 | x]; return [0xA, prm];
    case 'E': if (x === 15) return [0xE, 0x20 | y]; if (x === 14) return [TM.X, 0x20 | y]; return [0x2, prm];
    case 'F': if (x === 15) return [0xE, 0x10 | y]; if (x === 14) return [TM.X, 0x10 | y]; return [0x1, prm];
    case 'G': return [0x3, prm];
    case 'H': return [0x4, prm];
    case 'I': return [TM.T, prm];
    case 'J': return [0x0, prm];
    case 'K': return [0x6, prm];
    case 'L': return [0x5, prm];
    case 'O': return [0x9, prm];
    case 'Q': return [TM.R, prm];
    case 'R': return [0x7, prm];
    case 'S':
      if (x === 8) return [0x8, y * 17];
      if (x === 0xB) return [0xE, 0x60 | y];
      if (x === 0xC) return [0xE, 0xC0 | y];
      if (x === 0xD) return [0xE, 0xD0 | y];
      if (x === 0xE) return [0xE, 0xE0 | y];
      if (x === 2) return [0xE, 0x50 | y];
      if (x === 0xA) { notes.push('SAx high sample offset'); return [TM_NONE, 0]; }
      notes.push(`S${x.toString(16).toUpperCase()}x`); return [TM_NONE, 0];
    case 'T': return prm >= 32 ? [TM.TEMPO, prm] : [TM_NONE, 0];
    case 'U': notes.push('Uxy fine vibrato (as Hxy)'); return [0x4, x << 4 | Math.max(1, y >> 2)];
    case 'V': return [TM.G, it ? Math.min(128, prm) >> 1 : Math.min(64, prm)];
    case 'X': return [0x8, it ? prm : Math.min(255, prm * 2)];
    case 'W': if (it) return [TM.H, prm]; break;
    case 'P': if (it) return [TM.P, y << 4 | x]; break;       // IT: P0x right, Px0 left; XM the other way
    case 'M': if (it) { notes.push('channel volume'); return [TM_NONE, 0]; } break;
    case 'N': if (it) { notes.push('channel volume slide'); return [TM_NONE, 0]; } break;
    case 'Y': if (it) { notes.push('panbrello'); return [TM_NONE, 0]; } break;
    case 'Z': if (it) { notes.push('MIDI macros'); return [TM_NONE, 0]; } break;
  }
  notes.push(String.fromCharCode(64 + cmd) + 'xx');
  return [TM_NONE, 0];
}

// A ping-pong loop as a forward one: the sample up to the loop's end, then
// the loop backwards without its two ends. Returns [data, loop length].
function tmPingPong(data, bits, ls, ll) {
  if (ll <= 2) return [data, ll];
  const bps = bits / 8, body = data.subarray(0, (ls + ll) * bps), back = new Uint8Array((ll - 2) * bps);
  for (let k = 0; k < ll - 2; k++) back.set(data.subarray((ls + ll - 2 - k) * bps, (ls + ll - 1 - k) * bps), k * bps);
  const out = new Uint8Array(body.length + back.length); out.set(body); out.set(back, body.length);
  return [out, 2 * ll - 2];
}

export const isS3m = (b) => b.length >= 96 && String.fromCharCode(b[44], b[45], b[46], b[47]) === 'SCRM';

export function readS3m(buf) {
  const d = new Uint8Array(buf), dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  const text = (a, n) => String.fromCharCode(...d.subarray(a, a + n)).replace(/\0.*$/s, '').replace(/[^\x20-\x7e]/g, ' ').trim();
  if (!isS3m(d)) throw new Error('not a Scream Tracker 3 module');
  const ordNum = u16(32), insNum = u16(34), patNum = u16(36), flags = u16(38), cwt = u16(40), ffi = u16(42);
  const notes = [];
  const m = { kind: 's3m', name: text(0, 28), order: [], pats: [], samples: [], instruments: [], speed: d[49] || 6, tempo: d[50] >= 32 ? d[50] : 125,
    globalVolume: Math.min(64, d[48]), linear: false, fastSlides: !!(flags & 64) || cwt === 0x1300, notes };
  // channels: those in use, in order, with their default pan
  const stereo = !!(d[51] & 0x80), chanMap = new Map(), pans = [];
  for (let c = 0; c < 32; c++) {
    const set = d[64 + c];
    if (set >= 128) continue;
    chanMap.set(c, pans.length);
    pans.push(!stereo ? 128 : set < 8 ? 0x30 : set < 16 ? 0xC0 : 128);
  }
  const ordAt = 96, insAt = ordAt + ordNum, patAt = insAt + insNum * 2, panAt = patAt + patNum * 2;
  if (d[53] === 252) for (const [c, k] of chanMap) { const p = d[panAt + c]; if (p & 0x20) pans[k] = (p & 15) * 17; }
  for (let i = 0; i < ordNum; i++) { const o = d[ordAt + i]; if (o === 255) break; if (o < 254) m.order.push(o); }
  // samples
  for (let i = 0; i < insNum; i++) {
    const o = u16(insAt + 2 * i) * 16, s = { name: '', frames: 0, bits: 8, data: new Uint8Array(0), loopStart: 0, loopLength: 0, volume: 0, pan: null, c5: 8363 };
    m.samples.push(s);
    if (!o || o + 80 > d.length) continue;
    s.name = text(o + 48, 28) || text(o + 1, 12);
    if (d[o] !== 1) continue;                          // not a sample (an empty slot or AdLib)
    const at = (d[o + 13] << 16 | u16(o + 14)) * 16, len = u32(o + 16), fl = d[o + 31];
    s.volume = Math.min(64, d[o + 28]); s.c5 = u32(o + 32) || 8363; s.bits = fl & 4 ? 16 : 8;
    if (d[o + 30]) { notes.push(`sample ${i + 1} is packed (skipped)`); continue; }
    const bytes = s.bits / 8, n = Math.max(0, Math.min(len, Math.floor((d.length - at) / bytes)));
    const out = new Uint8Array(n * bytes);
    for (let k = 0; k < n; k++) {                      // stereo samples: the left side; unsigned to signed
      if (bytes === 1) out[k] = ffi === 2 ? d[at + k] ^ 0x80 : d[at + k];
      else { const v = dv.getUint16(at + 2 * k, true) ^ (ffi === 2 ? 0x8000 : 0); out[2 * k] = v & 255; out[2 * k + 1] = v >> 8; }
    }
    s.data = out; s.frames = n;
    if (fl & 1) { const ls = Math.min(u32(o + 20), n), le = Math.min(u32(o + 24), n); if (le > ls + 1) { s.loopStart = ls; s.loopLength = le - ls; } }
  }
  m.instruments = m.samples.map((s, i) => ({ name: s.name, map: new Array(96).fill(i), env: null, panEnv: null, fadeout: 0 }));
  // patterns
  for (let p = 0; p < patNum; p++) {
    const cells = Array.from({ length: 64 }, () => Array.from({ length: pans.length }, () => null));
    m.pats.push({ rows: 64, cells });
    const o = u16(patAt + 2 * p) * 16;
    if (!o || o + 2 > d.length) continue;
    let q = o + 2;
    for (let r = 0; r < 64 && q < d.length; r++) {
      for (;;) {
        const what = d[q++];
        if (!what) break;
        const c = { note: null, inst: 0, vol: null, volfx: 0, fx: TM_NONE, prm: 0 };
        if (what & 32) {
          const n = d[q++]; c.inst = d[q++];
          if (n === 254) c.note = 'off';
          else if (n < 254) c.note = 12 * ((n >> 4) + 1) + (n & 15);      // C-4 is MIDI 60
        }
        if (what & 64) c.vol = Math.min(64, d[q++]);
        if (what & 128) { const cmd = d[q++], prm = d[q++]; if (cmd) [c.fx, c.prm] = tmEffect(cmd, prm, notes, false); }
        const k = chanMap.get(what & 31);
        if (k !== undefined && r < 64) cells[r][k] = c;
      }
    }
  }
  m.nch = pans.length; m.pans = pans;
  m.notes = [...new Set(notes)];
  return m;
}

// ---------------------------------------------------------------- FastTracker 2 (.xm)

export const isXm = (b) => b.length >= 80 && String.fromCharCode(...b.subarray(0, 17)) === 'Extended Module: ';

export function readXm(buf) {
  const d = new Uint8Array(buf), dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  const text = (a, n) => String.fromCharCode(...d.subarray(a, a + n)).replace(/\0.*$/s, '').replace(/[^\x20-\x7e]/g, ' ').trim();
  if (!isXm(d)) throw new Error('not a FastTracker 2 module');
  if (u16(58) < 0x0104) throw new Error('an XM before version 1.04 is not supported');
  const hsize = u32(60), songLen = u16(64), nch = u16(68), npat = u16(70), nins = u16(72), flags = u16(74);
  const notes = [];
  const m = { kind: 'xm', name: text(17, 20), nch, order: Array.from(d.subarray(80, 80 + Math.min(256, songLen))), pats: [], samples: [], instruments: [],
    speed: u16(76) || 6, tempo: u16(78) || 125, globalVolume: 64, linear: !!(flags & 1), fastSlides: false, pans: new Array(nch).fill(128), notes,
    restart: u16(66) };
  let at = 60 + hsize;
  for (let p = 0; p < npat; p++) {
    const hl = u32(at), rows = u16(at + 5) || 64, size = u16(at + 7);
    let q = at + hl;
    const cells = Array.from({ length: rows }, () => Array.from({ length: nch }, () => null));
    for (let r = 0; r < rows && size; r++) for (let c = 0; c < nch; c++) {
      let b = d[q++], note = 0, inst = 0, vol = 0, fx = 0, prm = 0;
      if (b & 0x80) {
        if (b & 1) note = d[q++]; if (b & 2) inst = d[q++]; if (b & 4) vol = d[q++]; if (b & 8) fx = d[q++]; if (b & 16) prm = d[q++];
      } else { note = b; inst = d[q++]; vol = d[q++]; fx = d[q++]; prm = d[q++]; }
      if (!(note || inst || vol || fx || prm)) continue;
      const cell = { note: note === 97 ? 'off' : note >= 1 && note <= 96 ? note + 11 : null, inst, vol: null, volfx: 0, fx: TM_NONE, prm: 0 };
      if (vol >= 0x10 && vol <= 0x50) cell.vol = vol - 0x10; else if (vol >= 0x60) cell.volfx = vol;
      if (fx || prm) {
        if (fx === 0xF) [cell.fx, cell.prm] = prm < 32 ? (prm ? [TM.SPEED, prm] : [TM_NONE, 0]) : [TM.TEMPO, prm];
        else if (fx === 0xD) [cell.fx, cell.prm] = [TM.BREAK, (prm >> 4) * 10 + (prm & 15)];
        else [cell.fx, cell.prm] = [fx, prm];
      }
      cells[r][c] = cell;
    }
    m.pats.push({ rows, cells });
    at += hl + size;
  }
  for (let i = 0; i < nins && at + 29 <= d.length; i++) {
    const ihs = u32(at), name = text(at + 4, 22), ns = u16(at + 27);
    const ins = { name, map: new Array(96).fill(-1), env: null, panEnv: null, fadeout: 0 };
    m.instruments.push(ins);
    if (!ns) { at += ihs; continue; }
    const shs = u32(at + 29), base = m.samples.length, km = d.subarray(at + 33, at + 129);
    const points = (o, n) => Array.from({ length: Math.min(12, n) }, (_, k) => [u16(o + 4 * k), Math.min(64, u16(o + 4 * k + 2))]);
    const env = (o, n, sus, ls, le, type) => (type & 1 && n ? { points: points(o, n), sustain: type & 2 ? sus : -1, loop: type & 4 ? [ls, le] : null } : null);
    ins.env = env(at + 129, d[at + 225], d[at + 227], d[at + 228], d[at + 229], d[at + 233]);
    ins.panEnv = env(at + 177, d[at + 226], d[at + 230], d[at + 231], d[at + 232], d[at + 234]);
    ins.fadeout = u16(at + 239);
    if (d[at + 236] || d[at + 237]) notes.push('instrument auto-vibrato');
    ins.map = Array.from(km, (k) => (k < ns ? base + k : -1));
    let sh = at + ihs;
    const heads = [];
    for (let k = 0; k < ns; k++, sh += shs) {
      const type = d[sh + 14];
      heads.push({ len: u32(sh), ls: u32(sh + 4), ll: u32(sh + 8), volume: Math.min(64, d[sh + 12]), finetune: dv.getInt8(sh + 13), type,
        pan: d[sh + 15], relnote: dv.getInt8(sh + 16), name: text(sh + 18, 22) });
    }
    let q = sh;
    for (const h of heads) {                           // delta-coded 8- or 16-bit
      const bits = h.type & 16 ? 16 : 8, n = Math.max(0, Math.min(h.len, d.length - q)), frames = bits === 16 ? n >> 1 : n;
      let data = new Uint8Array(frames * (bits / 8)), acc = 0;
      for (let k = 0; k < frames; k++) {
        if (bits === 8) { acc = (acc + d[q + k]) & 255; data[k] = acc; }
        else { acc = (acc + dv.getUint16(q + 2 * k, true)) & 0xFFFF; data[2 * k] = acc & 255; data[2 * k + 1] = acc >> 8; }
      }
      q += h.len;
      let ls = bits === 16 ? h.ls >> 1 : h.ls, ll = bits === 16 ? h.ll >> 1 : h.ll;
      const loop = h.type & 3;
      if (!loop || ll < 2 || ls >= frames) { ls = 0; ll = 0; }
      else ll = Math.min(ll, frames - ls);
      if (loop === 2) [data, ll] = tmPingPong(data, bits, ls, ll);
      m.samples.push({ name: h.name || name, frames: data.length / (bits / 8), bits, data, loopStart: ls, loopLength: ll, volume: h.volume,
        pan: h.pan, relnote: h.relnote, finetune: h.finetune });
    }
    at = q;
  }
  m.notes = [...new Set(notes)];
  return m;
}

// ---------------------------------------------------------------- Impulse Tracker (.it)

export const isIt = (b) => b.length >= 192 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'IMPM';

// IT 2.14 and 2.15 compressed samples: blocks of 0x8000 (8-bit) or 0x4000
// (16-bit) frames, each a 16-bit byte count and then a bit stream of
// variable-width deltas (once integrated, or twice for IT 2.15). Returns
// signed PCM, little-endian for 16-bit, of `frames` frames.
function itUnpack(d, at, frames, bits, it215) {
  const out = bits === 16 ? new Int16Array(frames) : new Int8Array(frames), top = bits + 1;
  const blockFrames = bits === 16 ? 0x4000 : 0x8000;
  let q = at, done = 0;
  while (done < frames && q + 2 <= d.length) {
    const len = d[q] | d[q + 1] << 8, end = Math.min(d.length, q + 2 + len);
    let p = q + 2, buf = 0, have = 0;
    const read = (n) => {
      while (have < n) { buf |= (p < end ? d[p] : 0) * 2 ** have; p++; have += 8; }
      const v = buf % 2 ** n; buf = Math.floor(buf / 2 ** n); have -= n; return v;
    };
    const count = Math.min(blockFrames, frames - done);
    let width = top, d1 = 0, d2 = 0, k = 0;
    while (k < count && p <= end) {
      let v = read(width);
      if (width < 7) {                                   // method 1: 1-6 bits, an escape gives a new width
        if (v === 1 << (width - 1)) { v = read(bits === 16 ? 4 : 3) + 1; width = v < width ? v : v + 1; continue; }
      } else if (width < top) {                          // method 2: a band near the top of the range gives a new width
        const border = ((bits === 16 ? 0xFFFF : 0xFF) >> (top - width)) - (bits === 16 ? 8 : 4);
        if (v > border && v <= border + (bits === 16 ? 16 : 8)) { v -= border; width = v < width ? v : v + 1; continue; }
      } else if (width === top) {                        // method 3: the top bit set gives a new width
        if (v & (1 << bits)) { width = (v + 1) & 0xFF; continue; }
      } else break;                                      // a broken stream
      if (width < bits) { const sh = 32 - width; v = (v << sh) >> sh; }   // sign-extend
      else v = bits === 16 ? (v << 16) >> 16 : (v << 24) >> 24;
      d1 = bits === 16 ? (d1 + v) << 16 >> 16 : (d1 + v) << 24 >> 24;
      d2 = bits === 16 ? (d2 + d1) << 16 >> 16 : (d2 + d1) << 24 >> 24;
      out[done + k++] = it215 ? d2 : d1;
    }
    done += count;
    q += 2 + len;
  }
  return new Uint8Array(out.buffer);
}

export function readIt(buf) {
  const d = new Uint8Array(buf), dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  const text = (a, n) => String.fromCharCode(...d.subarray(a, Math.min(d.length, a + n))).replace(/\0.*$/s, '').replace(/[^\x20-\x7e]/g, ' ').trim();
  if (!isIt(d)) throw new Error('not an Impulse Tracker module');
  const ordNum = u16(0x20), insNum = u16(0x22), smpNum = u16(0x24), patNum = u16(0x26), cmwt = u16(0x2A), flags = u16(0x2C);
  const notes = [], useIns = !!(flags & 4);
  const m = { kind: 'it', name: text(4, 26), order: [], pats: [], samples: [], instruments: [], speed: d[0x32] || 6, tempo: d[0x33] >= 32 ? d[0x33] : 125,
    globalVolume: Math.min(128, d[0x30]) >> 1, linear: !!(flags & 8), fastSlides: false, notes };
  if (flags & 16) notes.push('old effects (played as new ones)');
  for (let i = 0; i < ordNum; i++) { const o = d[0xC0 + i]; if (o === 255) break; if (o < 200) m.order.push(o); }
  const insAt = 0xC0 + ordNum, smpAt = insAt + 4 * insNum, patAt = smpAt + 4 * smpNum;
  // samples
  for (let i = 0; i < smpNum; i++) {
    const o = u32(smpAt + 4 * i), s = { name: '', frames: 0, bits: 8, data: new Uint8Array(0), loopStart: 0, loopLength: 0, volume: 0, pan: null, c5: 8363 };
    m.samples.push(s);
    if (!o || o + 0x50 > d.length || text(o, 4) !== 'IMPS') continue;
    const fl = d[o + 0x12], cvt = d[o + 0x2E], dfp = d[o + 0x2F], gvl = Math.min(64, d[o + 0x11]);
    s.name = text(o + 0x14, 26) || text(o + 4, 12);
    s.volume = Math.min(64, d[o + 0x13]); s.c5 = u32(o + 0x3C) || 8363; s.bits = fl & 2 ? 16 : 8;
    if (dfp & 0x80) s.pan = Math.min(255, (dfp & 127) * 4);
    if (d[o + 0x4D]) notes.push('sample vibrato');
    if (!(fl & 1)) continue;
    if (fl & 4) notes.push('stereo samples (their left side)');
    const len = u32(o + 0x30), at = u32(o + 0x48), bytes = s.bits / 8;
    let data;
    if (fl & 8) data = itUnpack(d, at, len, s.bits, !!(cvt & 4));
    else {
      const n = Math.max(0, Math.min(len, Math.floor((d.length - at) / bytes)));
      data = new Uint8Array(n * bytes);
      let acc = 0;
      for (let k = 0; k < n; k++) {                      // stereo samples: the left side; unsigned or delta to signed
        let v = bytes === 1 ? d[at + k] : u16(at + 2 * k);
        if (cvt & 4) v = acc = (acc + v) & (bytes === 1 ? 0xFF : 0xFFFF);
        if (!(cvt & 1)) v ^= bytes === 1 ? 0x80 : 0x8000;
        if (bytes === 1) data[k] = v; else { data[2 * k] = v & 255; data[2 * k + 1] = v >> 8; }
      }
    }
    if (gvl < 64) {                                      // the sample's global volume, into the sample
      const g = gvl / 64;
      if (bytes === 1) for (let k = 0; k < data.length; k++) data[k] = Math.round(((data[k] << 24) >> 24) * g) & 255;
      else for (let k = 0; k < data.length; k += 2) { const v = Math.round(((data[k] | data[k + 1] << 8) << 16 >> 16) * g) & 0xFFFF; data[k] = v & 255; data[k + 1] = v >> 8; }
    }
    s.data = data; s.frames = data.length / bytes;
    let ls = u32(o + 0x34), le = u32(o + 0x38), pp = fl & 64;
    if (!(fl & 16) && fl & 32) { ls = u32(o + 0x40); le = u32(o + 0x44); pp = fl & 128; notes.push('sustain loops (as loops)'); }
    if (fl & 48) {
      ls = Math.min(ls, s.frames); le = Math.min(le, s.frames);
      if (le > ls + 1) { s.loopStart = ls; s.loopLength = le - ls; if (pp) { [s.data, s.loopLength] = tmPingPong(s.data, s.bits, ls, le - ls); s.frames = s.data.length / bytes; } }
    }
  }
  // instruments: a key map (note -> sample) and envelopes; without them, one per sample
  if (useIns) for (let i = 0; i < insNum; i++) {
    const o = u32(insAt + 4 * i), ins = { name: '', map: new Array(96).fill(-1), env: null, panEnv: null, fadeout: 0 };
    m.instruments.push(ins);
    if (!o || o + 0x130 > d.length || text(o, 4) !== 'IMPI') continue;
    ins.name = text(o + 0x20, 26) || text(o + 4, 12);
    let moved = false;
    for (let k = 0; k < 96; k++) {
      const n = d[o + 0x40 + 2 * (k + 12)], smp = d[o + 0x41 + 2 * (k + 12)];
      ins.map[k] = smp && smp <= smpNum ? smp - 1 : -1;
      if (smp && n !== k + 12) moved = true;
    }
    if (moved) notes.push('key maps that move notes (played as written)');
    if (cmwt < 0x200) {                                  // the old instrument format: its fade-out only
      ins.fadeout = u16(o + 0x18) * 128;
      if (d[o + 0x11] & 1) notes.push('old-format envelopes');
      continue;
    }
    ins.fadeout = u16(o + 0x14) * 64;
    if (d[o + 0x11]) notes.push('new note actions (each note cuts the one before)');
    if (d[o + 0x18] < 128) notes.push('instrument global volume');
    const env = (e, pan) => {
      if (!(d[e] & 1) || !d[e + 1]) return null;
      const n = Math.min(25, d[e + 1]), points = Array.from({ length: n }, (_, k) => [u16(e + 7 + 3 * k), pan ? ((d[e + 6 + 3 * k] << 24) >> 24) + 32 : Math.min(64, d[e + 6 + 3 * k])]);
      if (d[e] & 4 && d[e + 4] !== d[e + 5]) notes.push('envelope sustain loops (held at their start)');
      return { points, sustain: d[e] & 4 ? Math.min(d[e + 4], n - 1) : -1, loop: d[e] & 2 ? [Math.min(d[e + 2], n - 1), Math.min(d[e + 3], n - 1)] : null };
    };
    ins.env = env(o + 0x130, false);
    ins.panEnv = env(o + 0x182, true);
    if (d[o + 0x1D4] & 1) notes.push(d[o + 0x1D4] & 0x80 ? 'filter envelopes' : 'pitch envelopes');
  }
  else m.instruments = m.samples.map((s, i) => ({ name: s.name, map: new Array(96).fill(i), env: null, panEnv: null, fadeout: 0 }));
  // patterns: the channels in use, in order, with their default pan and volume
  const raw = [], used = new Set();
  for (let p = 0; p < patNum; p++) {
    const o = u32(patAt + 4 * p), rows = o && o + 8 <= d.length ? u16(o + 2) || 64 : 64, list = [];
    raw.push({ rows, list });
    if (!o || o + 8 > d.length) continue;
    const end = Math.min(d.length, o + 8 + u16(o)), mask = new Array(64).fill(0), lastCell = Array.from({ length: 64 }, () => ({ note: 0, inst: 0, vp: 255, cmd: 0, prm: 0 }));
    let q = o + 8;
    for (let r = 0; r < rows && q < end;) {
      const cv = d[q++];
      if (!cv) { r++; continue; }
      const c = (cv - 1) & 63;
      if (cv & 128) mask[c] = d[q++];
      const mk = mask[c], L = lastCell[c], cell = { note: -1, inst: 0, vp: 255, cmd: 0, prm: 0 };
      if (mk & 1) cell.note = L.note = d[q++];
      if (mk & 2) cell.inst = L.inst = d[q++];
      if (mk & 4) cell.vp = L.vp = d[q++];
      if (mk & 8) { cell.cmd = L.cmd = d[q++]; cell.prm = L.prm = d[q++]; }
      if (mk & 16) cell.note = L.note;
      if (mk & 32) cell.inst = L.inst;
      if (mk & 64) cell.vp = L.vp;
      if (mk & 128) { cell.cmd = L.cmd; cell.prm = L.prm; }
      list.push([r, c, cell]);
      used.add(c);
    }
  }
  const chanMap = new Map(), pans = [], chanVols = [];
  for (let c = 0; c < 64; c++) {
    if (!used.has(c) || d[0x40 + c] & 128) continue;
    chanMap.set(c, pans.length);
    const p = d[0x40 + c];
    pans.push(p === 100 ? 128 : Math.min(255, Math.min(64, p) * 4));
    if (p === 100) notes.push('surround channels (as centre)');
    chanVols.push(Math.min(64, d[0x80 + c]));
  }
  const IT_PORTA = [0, 1, 4, 8, 16, 32, 64, 96, 128, 255];
  for (const { rows, list } of raw) {
    const cells = Array.from({ length: rows }, () => Array.from({ length: pans.length }, () => null));
    for (const [r, src, it] of list) {
      const k = chanMap.get(src);
      if (k === undefined) continue;
      const c = { note: null, inst: it.inst, vol: null, volfx: 0, fx: TM_NONE, prm: 0 }, n = it.note, v = it.vp;
      if (n >= 0 && n <= 119) c.note = n;                 // C-5 is MIDI 60
      else if (n === 254) { c.note = 'off'; c.vol = 0; }  // note cut
      else if (n === 255) c.note = 'off';
      else if (n >= 120) { c.note = 'off'; notes.push('note fade (as note off)'); }
      if (v <= 64) c.vol = v;
      else if (v <= 74) c.volfx = 0x90 | (v - 65);        // fine volume up
      else if (v <= 84) c.volfx = 0x80 | (v - 75);        // fine volume down
      else if (v <= 94) c.volfx = 0x70 | (v - 85);        // volume slide up
      else if (v <= 104) c.volfx = 0x60 | (v - 95);       // volume slide down
      else if (v <= 124) notes.push('pitch slides in the volume column');
      else if (v >= 128 && v <= 192) c.volfx = 0xC0 | Math.min(15, (v - 128) >> 2);
      else if (v >= 193 && v <= 202) c.volfx = 0xF0 | Math.max(v > 193 ? 1 : 0, Math.min(15, Math.round(IT_PORTA[v - 193] / 16)));
      else if (v >= 203 && v <= 212) c.volfx = 0xB0 | (v - 203);
      if (it.cmd) [c.fx, c.prm] = tmEffect(it.cmd, it.prm, notes, true);
      cells[r][k] = c;
    }
    m.pats.push({ rows, cells });
  }
  if (chanVols.some((v) => v < 64)) notes.push('channel volumes');
  m.nch = pans.length; m.pans = pans; m.chanVols = chanVols;
  m.notes = [...new Set(notes)];
  return m;
}

// ---------------------------------------------------------------- pitch

// Scream Tracker's and FastTracker's periods (in the finer units both use:
// four to an Amiga period) and the frequency of each.
const S3M_TAB = [1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 907];
const tmAmiga = (m) => m.kind === 's3m' || (m.kind === 'it' && !m.linear);
function tmPeriod(m, s, midi) {
  if (tmAmiga(m)) {
    const n = midi - 12, oct = Math.floor(n / 12), semi = ((n % 12) + 12) % 12;
    return 8363 * 16 * (S3M_TAB[semi] / 2 ** oct) / (s.c5 || 8363);
  }
  if (m.kind === 'it') return 7680 - (midi - 12) * 64 - 768 * Math.log2((s.c5 || 8363) / 8363);   // linear: MIDI 60 at C5 speed
  const real = midi - 12 + s.relnote;                  // XM: note 0 is C-0; C-4 (48) plays at 8363 Hz
  if (m.linear) return 7680 - real * 64 - s.finetune / 2;
  return 8363 * 1712 / (8363 * 2 ** ((real - 48 + s.finetune / 128) / 12));
}
function tmFreq(m, period) {
  if (tmAmiga(m)) return 14317056 / period;
  if (m.linear) return 8363 * 2 ** ((4608 - period) / 768);
  return 8363 * 1712 / period;
}
const tmRate = (m, s) => tmFreq(m, tmPeriod(m, s, 60));   // the sample's rate at C-4 (MIDI 60)

// ---------------------------------------------------------------- instruments

// One RetCon instrument and wave per module sample: it plays on its fourth
// operator, without smoothing. With `env`, an XM instrument's volume
// envelope is fitted to the operator's attack, decay, sustain and release
// (best effort); exact import plays the envelope as volume commands.
function tmInstruments(m, song, fit) {
  const owner = new Map();
  m.instruments.forEach((ins, i) => ins.map.forEach((s) => { if (s >= 0 && !owner.has(s)) owner.set(s, i); }));
  const tps = m.tempo * 2 / 5;                          // ticks a second
  const envMs = (v) => (v <= 1 ? 0 : Math.max(0, Math.min(255, Math.round(64 * Math.log10(v)))));
  m.samples.forEach((s, k) => {
    song.waves.push({ kind: 'sample', name: s.name, frames: s.frames, loopStart: s.loopStart, loopLength: s.loopLength,
      rate: Math.max(1, Math.round(tmRate(m, s))), root: 60, format: s.bits === 16 ? 0 : 1, data: s.data });
    const b = new Uint8Array(INSTRUMENT_SIZE), o = 60, ins = m.instruments[owner.has(k) ? owner.get(k) : -1];
    b[o] = WAVE_SAMPLE; b[o + 1] = 2; b[o + 3] = 255; b[o + 6] = OP_SAMPLE_NEAREST;
    b[o + 12] = 0; b[o + 13] = 0; b[o + 14] = 255; b[o + 15] = 32;
    if (fit && ins && ins.env) {                       // the envelope as attack, decay, sustain, release
      const pts = ins.env.points, peak = pts.reduce((a, p, i) => (p[1] > pts[a][1] ? i : a), 0);
      const sus = ins.env.sustain >= 0 ? Math.min(ins.env.sustain, pts.length - 1) : pts.length - 1;
      b[o + 12] = envMs(pts[peak][0] / tps * 1000);
      b[o + 13] = envMs(Math.max(0, pts[sus][0] - pts[peak][0]) / tps * 1000 * 0.45);
      b[o + 14] = Math.round(255 * pts[sus][1] / 64);
      b[o + 15] = ins.fadeout ? envMs(65536 / ins.fadeout / tps * 1000 * 0.45) : 32;
      if (ins.env.sustain < 0) b[o + 8] = b[o + 15];   // no sustain: it fades on
    }
    setU32(b, o + 16, k);
    b[80] = 7; b[82] = 255;
    const name = ins && ins.name && ins.name !== s.name ? `${ins.name}: ${s.name}` : s.name;
    song.instruments.push({ name: name || `Sample ${k + 1}`, bytes: b });
  });
}

// the sample (RetCon instrument) a module instrument plays for a note
function tmSampleFor(m, inst, midi) {
  const ins = m.instruments[inst - 1];
  if (!ins) return -1;
  const k = typeof midi === 'number' ? Math.max(0, Math.min(95, midi - 12)) : 48;
  return ins.map[k] !== undefined ? ins.map[k] : -1;
}

// at most 16 channels: those with the most notes, in their order
function tmChannels(m) {
  if (m.nch <= 16) return { keep: Array.from({ length: m.nch }, (_, i) => i), dropped: 0 };
  const count = new Array(m.nch).fill(0);
  for (const p of m.pats) for (const row of p.cells) row.forEach((c, i) => { if (c && typeof c.note === 'number') count[i]++; });
  const keep = count.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, 16).map((x) => x[1]).sort((a, b) => a - b);
  const gone = count.map((n, i) => [n, i]).filter(([, i]) => !keep.includes(i));
  return { keep, dropped: m.nch - 16, notes: gone.reduce((a, [n]) => a + n, 0),
    lost: [`${m.nch - 16} of the module's ${m.nch} channels left out (${gone.reduce((a, [n]) => a + n, 0)} notes); the song player has 16 channels. ` +
      `Channels left out, with their notes: ${gone.map(([n, i]) => `${i + 1} (${n})`).join(', ')}.`] };
}

// ---------------------------------------------------------------- packing many channels into 16
//
// Modules with more than 16 channels mostly use few at a time: a channel
// holds one note, so a composer spreads chords, doubled notes and echoes
// (the same note a few rows later on the next channel, quieter) over many,
// and each is idle most of the time. Packing cuts each pattern's channels
// into notes, each from its row to the next note, note off or volume 0 on
// its channel, or to the end of a sample that does not loop, and lays them
// on 16 channels where they do not overlap. Where more than 16 sound at
// once, the least needed go first: echoes and doubled notes, then the inner
// voices of chords, then the quietest; each instrument's leading note is
// kept longest. Speed, tempo, breaks, jumps and global volume survive on
// another channel. A note keeps its own channel's pan and volume.
const TM_GLOBAL = (c) => c && (c.fx === TM.SPEED || c.fx === TM.TEMPO || c.fx === 0xB || c.fx === TM.BREAK || c.fx === TM.G ||
  c.fx === TM.H || (c.fx === 0xE && ((c.prm >> 4) === 0xE || (c.prm >> 4) === 6)));

function tmPack(m, limit = 16) {
  const timing = new Map();                            // speed and tempo where each pattern first plays
  let sp = m.speed, te = m.tempo;
  for (const pi of m.order) {
    const p = m.pats[pi];
    if (!p) continue;
    if (!timing.has(pi)) timing.set(pi, [sp, te]);
    for (const row of p.cells) for (const c of row) if (c) { if (c.fx === TM.SPEED) sp = c.prm; else if (c.fx === TM.TEMPO) te = c.prm; }
  }
  const seq = [...new Set(m.order.filter((pi) => m.pats[pi]))];
  m.pats.forEach((p, pi) => { if (!seq.includes(pi)) seq.push(pi); });
  const home = new Array(m.nch).fill(-1), ringing = new Array(m.nch).fill(false);
  const cvs = m.chanVols || null, packed = new Array(m.pats.length);
  let width = 0, lostNotes = 0, cut = 0, movedGlobal = 0;
  const lostBy = new Map();                            // instrument -> notes left out
  for (const pi of seq) {
    const p = m.pats[pi], [speed, tempo] = timing.get(pi) || [m.speed, m.tempo], rowSec = speed * 2.5 / tempo;
    // each channel's notes as segments of rows
    const segs = [];
    for (let ch = 0; ch < m.nch; ch++) {
      let cur = null, inst = 0, vol = 64;
      if (ringing[ch]) cur = { ch, start: 0, end: p.rows, note: null, inst: 0, vol: 32, hasNote: false };   // a note still sounding from before
      for (let r = 0; r < p.rows; r++) {
        const c = p.cells[r][ch];
        if (!c) continue;
        if (c.inst) inst = c.inst;
        if (typeof c.note === 'number') {
          if (cur) { cur.end = Math.min(cur.end, r); segs.push(cur); }
          const s = m.samples[tmSampleFor(m, inst, c.note)];
          vol = c.vol !== null ? c.vol : c.inst && s ? s.volume : vol;
          let end = p.rows;
          if (s && s.frames && !s.loopLength) {
            const secs = s.frames / ((s.rate || tmRate(m, s)) * 2 ** ((c.note - 60) / 12));
            end = Math.min(end, r + Math.max(1, Math.ceil(secs / rowSec)));
          }
          cur = { ch, start: r, end, note: c.note, inst, vol, hasNote: true };
        } else if (cur && (c.note === 'off' || c.vol === 0)) cur.end = Math.min(cur.end, r + 1);
        else if (c.vol !== null) vol = c.vol;
      }
      if (cur) segs.push(cur);
      ringing[ch] = !!(cur && cur.end >= p.rows && (cur.hasNote || ringing[ch]));
    }
    // how much each is needed
    const byStart = new Map();
    for (const s of segs) if (s.hasNote) { const k = s.start + ':' + s.inst; if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(s); }
    for (const group of byStart.values()) {
      group.sort((a, b) => b.note - a.note || b.vol - a.vol);
      const seen = new Set();
      group.forEach((s, k) => {
        s.prio = (s.vol + 1) * (k === 0 ? 3 : k === group.length - 1 ? 1 : 0.5);   // the top note leads, then the bass, then inner voices
        if (seen.has(s.note)) s.prio *= 0.2;           // a doubled note
        seen.add(s.note);
      });
    }
    for (const s of segs) {
      if (!s.hasNote) { s.prio = 8; continue; }
      const echo = segs.some((e) => e !== s && e.hasNote && e.ch !== s.ch && e.inst === s.inst && e.note === s.note &&
        e.start < s.start && s.start - e.start <= 16 && e.vol >= s.vol);
      if (echo) s.prio *= 0.3;
    }
    // laid on channels: the earliest first, the most needed first among equals
    segs.sort((a, b) => a.start - b.start || b.prio - a.prio);
    const occ = new Array(limit).fill(null), last = new Array(limit).fill(-1), placed = [];
    for (const s of segs) {
      const free = (o) => !occ[o] || occ[o].end <= s.start;
      let o = home[s.ch] >= 0 && free(home[s.ch]) ? home[s.ch] : last.findIndex((src, k) => src === s.ch && free(k));
      if (o < 0) o = occ.findIndex((x, k) => free(k));
      if (o < 0) {                                     // all busy: cut the note least needed now, if it is needed less
        const now = (x) => x.prio / (1 + (s.start - x.start) / 4);   // a note that has sounded a while is needed less
        let low = 0;
        for (let k = 1; k < limit; k++) if (now(occ[k]) < now(occ[low])) low = k;
        if (now(occ[low]) < s.prio) { occ[low].end = s.start; cut++; o = low; }
      }
      if (o < 0) {
        if (s.hasNote) { lostNotes++; lostBy.set(s.inst, (lostBy.get(s.inst) || 0) + 1); }
        continue;
      }
      s.out = o; occ[o] = s; last[o] = s.ch; home[s.ch] = o; placed.push(s);
      width = Math.max(width, o + 1);
    }
    // the packed pattern
    const cells = Array.from({ length: p.rows }, () => new Array(limit).fill(null)), outInst = new Array(limit).fill(0);
    placed.sort((a, b) => a.start - b.start);
    for (const s of placed) for (let r = s.start; r < s.end; r++) {
      const c = p.cells[r][s.ch];
      if (!c && r !== s.start) continue;
      const out = c ? Object.assign({}, c) : { note: null, inst: 0, vol: null, volfx: 0, fx: TM_NONE, prm: 0 };
      if (r === s.start && s.hasNote) {
        if (!out.inst && s.inst && outInst[s.out] !== s.inst) out.inst = s.inst;
        out.pan = m.pans[s.ch];
        if (cvs) out.cv = cvs[s.ch];
      }
      if (out.inst) outInst[s.out] = out.inst;
      if (TM_GLOBAL(c)) c.kept = true;
      cells[r][s.out] = out;
    }
    for (let r = 0; r < p.rows; r++) for (let ch = 0; ch < m.nch; ch++) {   // global effects of what was left out
      const c = p.cells[r][ch];
      if (!TM_GLOBAL(c) || c.kept) continue;
      const k = cells[r].findIndex((x) => !x || x.fx === TM_NONE);
      if (k < 0) continue;
      cells[r][k] = Object.assign(cells[r][k] || { note: null, inst: 0, vol: null, volfx: 0 }, { fx: c.fx, prm: c.prm });
      width = Math.max(width, k + 1); movedGlobal++;
    }
    packed[pi] = { rows: p.rows, cells };
  }
  width = Math.max(1, width);
  const out = Object.assign({}, m, { nch: width, pats: packed.map((p) => ({ rows: p.rows, cells: p.cells.map((row) => row.slice(0, width)) })),
    pans: new Array(width).fill(128), chanVols: null, packedFrom: m.nch });
  out.notes = [...m.notes, `its ${m.nch} channels packed into ${width}` + (lostNotes ? `, ${lostNotes} note${lostNotes === 1 ? '' : 's'} left out where more than ${limit} sounded at once` : '')];
  out.lost = lostNotes ? [`${lostNotes} note${lostNotes === 1 ? '' : 's'} left out where more than ${limit} sounded at once (echoes, doubled notes and inner chord voices first; ` +
    `${cut} notes cut short). By instrument: ${[...lostBy].sort((a, b) => b[1] - a[1]).map(([i, n]) => `${(i - 1).toString(16).toUpperCase().padStart(2, '0')} (${n})`).join(', ')}.`] : [];
  return out;
}

// A ProTracker module (mod.js) with more than 16 channels, packed the same
// way: its cells in the common form for tmPack, and back. A packed note
// carries its channel's pan (-128 to 127, as mod.js keeps it).
function modPack(m) {
  const blank = { smp: 0, per: 0, fx: 0, prm: 0 };
  const fxOf = (c) => (c.fx === 0xF ? (!c.prm ? TM_NONE : c.prm < 32 ? TM.SPEED : TM.TEMPO) : c.fx === 0xD ? TM.BREAK : c.fx || c.prm ? c.fx : TM_NONE);
  const fxBack = (fx) => (fx === TM.SPEED || fx === TM.TEMPO ? 0xF : fx === TM.BREAK ? 0xD : fx);
  const common = { kind: 'mod', nch: m.nch, order: m.order, speed: 6, tempo: 125, pans: m.pans.map((p) => p + 128), chanVols: null, notes: [],
    samples: m.samples.map((sm) => ({ frames: sm.length, loopLength: sm.loopLength, volume: sm.volume,
      rate: PAL_CLOCK / MOD_ROOT_PERIOD * 2 ** (sm.finetune / 96) })),
    instruments: m.samples.map((_, i) => ({ map: new Array(96).fill(i) })),
    pats: m.pats.map((rows) => ({ rows: rows.length, cells: rows.map((row) => row.map((c) => {
      if (!c.smp && !c.per && !c.fx && !c.prm) return null;
      return { note: c.per ? modNote(c.per) : c.fx === 0xE && c.prm === 0xC0 ? 'off' : null, inst: c.smp <= 31 ? c.smp : 0,
        vol: c.fx === 0xC ? Math.min(64, c.prm) : null, volfx: 0, fx: fxOf(c), prm: c.prm, mod: c };
    })) })) };
  const out = tmPack(common);
  const back = (c) => {
    if (!c) return Object.assign({}, blank);
    const b = Object.assign({}, c.mod || blank);
    if (!c.mod || c.fx !== fxOf(c.mod)) { b.fx = c.fx === TM_NONE ? 0 : fxBack(c.fx); b.prm = c.fx === TM_NONE ? 0 : c.prm; }   // a global effect moved here
    if (c.inst) b.smp = c.inst;
    if (c.pan !== undefined) b.pan = c.pan - 128;
    return b;
  };
  const said = out.notes[out.notes.length - 1];
  return Object.assign({}, m, { nch: out.nch, pats: out.pats.map((p) => p.cells.map((row) => row.map(back))), pans: new Array(out.nch).fill(0),
    notes: [...m.notes, said[0].toUpperCase() + said.slice(1) + '.'], lost: out.lost, packedFrom: m.nch });
}

// A ProTracker module as a song: best effort, or with options.exact played as ProTracker plays it.
export function readMod(buf, options = {}) {
  const read = readModFile(buf);
  const m = read.nch > 16 && options.pack !== false ? modPack(read) : read;
  return options.exact ? modExact(m) : modPatterns(m);
}

function tmSong(m, nch) {
  return { name: m.name, auth: '', licn: '', desc: tmLabel(m) + ' module', date: '',
    bpm: m.tempo, tpb: 24, channels: nch, voices: Array.from({ length: 16 }, (_, i) => (i < nch ? i : 0)), instruments: [], waves: [],
    patterns: [], order: [], loop: -1, notes: [], ticksPerRow: m.speed, rowsPerBeat: Math.max(1, Math.round(24 / m.speed)) };
}
const tmLabel = (m) => ({ s3m: 'Scream Tracker 3', xm: 'FastTracker 2', it: 'Impulse Tracker' })[m.kind];

// ---------------------------------------------------------------- best effort: the module's own patterns

function tmPatterns(m) {
  const { keep, dropped, notes: lost, lost: missing } = tmChannels(m), song = tmSong(m, keep.length), ignored = new Map();
  const note = (k) => ignored.set(k, (ignored.get(k) || 0) + 1);
  song.lost = [...(m.lost || []), ...(missing || [])];
  tmInstruments(m, song, true);
  let speed = m.speed, tempo = m.tempo;
  const rows = m.pats.map((p) => {
    for (let r = 0; r < p.rows; r++) if (p.cells[r].some((c) => c && c.fx === TM.BREAK)) {
      if (p.cells[r].some((c) => c && c.fx === TM.BREAK && c.prm)) note('a break to a row other than 0');
      return r + 1;
    }
    return p.rows;
  });
  song.order = m.order.filter((pi) => m.pats[pi]);
  song.order.some((pi, k) => m.pats[pi].cells.slice(0, rows[pi]).some((row) => row.some((c) => {
    if (!c || c.fx !== 0xB) return false;
    if (c.prm <= k) { song.loop = c.prm; song.order = song.order.slice(0, k + 1); return true; }
    note('a jump forward'); return false;
  })));
  if (song.loop < 0 && m.kind === 'xm' && m.restart < song.order.length && m.restart >= 0) song.loop = m.restart;
  const used = new Set(song.order), first = song.order[0];
  const cents = (from, to) => Math.min(255, Math.max(1, Math.round(1200 * Math.abs(Math.log2(to / from)))));
  song.patterns = m.pats.map((p, pi) => {
    const pat = newPattern(rows[pi], keep.length);
    keep.forEach((src, ch) => {
      let inst = 0, midi = 60, porta = 0, vib = [0, 0];
      for (let r = 0; r < rows[pi]; r++) {
        const cl = p.cells[r][src];
        if (!cl) continue;
        const c = emptyCell(), x = cl.prm >> 4, y = cl.prm & 15;
        if (cl.inst) inst = cl.inst;
        if (cl.note === 'off') c.off = true;
        else if (typeof cl.note === 'number') { c.note = cl.note; midi = cl.note; }
        const smp = tmSampleFor(m, inst, midi), s = m.samples[smp];
        if (cl.inst && s && (cl.note !== null || m.kind !== 'xm')) { c.inst = smp; c.vol = modVolume(s.volume); }
        if (cl.vol !== null) c.vol = modVolume(cl.vol);
        const per = s ? tmPeriod(m, s, midi) : 1712, slide = (units) => cents(tmFreq(m, per), tmFreq(m, per - units));
        switch (cl.fx) {
          case 0x0: if (cl.prm) { c.fx = 0; c.param = cl.prm; } break;
          case 0x1: if (cl.prm) { c.fx = 1; c.param = slide(4 * cl.prm); } break;
          case 0x2: if (cl.prm) { c.fx = 2; c.param = slide(-4 * cl.prm); } break;
          case 0x3: if (cl.prm) porta = cl.prm; if (c.note !== null) { c.fx = 3; c.param = slide(4 * (porta || 1)); } break;
          case 0x4: {
            if (x) vib[0] = x; if (y) vib[1] = y;
            const depth = Math.abs(1200 * Math.log2(tmFreq(m, per) / tmFreq(m, per + 2 * vib[1]))), hz = vib[0] * tempo * 2 / 5 / 64;
            c.fx = 4; c.param = Math.max(1, Math.min(15, Math.round(depth / 8))) << 4 | Math.max(1, Math.min(15, Math.round(hz)));
            break;
          }
          case 0x5: case 0x6: case 0xA:
            if (cl.fx !== 0xA) note(cl.fx === 5 ? 'tone portamento with a volume slide (as the slide)' : 'vibrato with a volume slide (as the slide)');
            if (cl.prm) { c.fx = 10; c.param = x ? Math.min(15, x * 4) << 4 : Math.min(15, y * 4); }
            break;
          case 0x7: note('tremolo'); break;
          case 0x8: c.raw.push(Uint8Array.of(CH.POSITION, (cl.prm - 128) & 0xFF, 0)); break;
          case 0x9: if (cl.prm) c.raw.push(Uint8Array.of(CH.SAMPLE_START, cl.prm, 0)); break;
          case 0xC: c.vol = modVolume(Math.min(64, cl.prm)); break;
          case 0xE: if (x === 0xC && y === 0 && c.note === null) c.off = true; else if (x) note(`E${x.toString(16).toUpperCase()}x`); break;
          case TM.SPEED: case TM.TEMPO:
            if (cl.fx === TM.SPEED) speed = cl.prm; else tempo = cl.prm;
            if (!(pi === first && r === 0)) { c.fx = 15; c.param = Math.min(255, Math.round(tempo * song.ticksPerRow / speed)); }
            break;
          case 0xB: case TM.BREAK: case TM_NONE: break;
          default: note({ [TM.G]: 'global volume', [TM.H]: 'global volume slide', [TM.K]: 'key off at a tick', [TM.L]: 'envelope position',
            [TM.P]: 'panning slide', [TM.R]: 'retrigger', [TM.T]: 'tremor', [TM.X]: 'extra fine portamento' }[cl.fx] || 'an effect');
        }
        if (cl.pan !== undefined) c.raw.push(Uint8Array.of(CH.POSITION, (cl.pan - 128) & 0xFF, 0));
        if (cl.volfx) note('volume column effects');
        if (!cellEmpty(c)) pat.cells[ch][r] = c;
      }
    });
    return pat;
  });
  const top = song.patterns[first];                    // the channels' pans, on the first row
  if (top) keep.forEach((src, ch) => {
    const c = top.cells[ch][0] || emptyCell();
    c.raw.unshift(Uint8Array.of(CH.POSITION, (m.pans[src] - 128) & 0xFF, 0));
    top.cells[ch][0] = c;
  });
  song.patterns.forEach((p, pi) => { p.name = used.has(pi) ? `pattern ${pi}` : `pattern ${pi} (unused)`; });
  song.notes = [`A ${m.packedFrom || m.nch}-channel ${tmLabel(m)} module: its patterns and order, the effects approximated.`, ...m.notes.map((n) => n[0].toUpperCase() + n.slice(1) + '.')];
  if (dropped) song.notes.push(`${dropped} channels beyond 16 dropped (${lost} notes).`);
  if (ignored.size) song.notes.push('Not carried over: ' + [...ignored].map(([k, n]) => `${k} ×${n}`).join(', ') + '.');
  return song;
}

// ---------------------------------------------------------------- exact: played tick by tick

function tmEnvValue(env, t) {
  const p = env.points;
  if (t <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++)
    if (t <= p[i][0]) return p[i - 1][1] + (p[i][1] - p[i - 1][1]) * (t - p[i - 1][0]) / Math.max(1, p[i][0] - p[i - 1][0]);
  return p[p.length - 1][1];
}

function tmExact(m) {
  const { keep, dropped, notes: lost, lost: missing } = tmChannels(m), song = tmSong(m, keep.length), ignored = new Map();
  const note = (k) => ignored.set(k, (ignored.get(k) || 0) + 1);
  tmInstruments(m, song, false);
  const chans = keep.map((src) => ({ cv: m.chanVols ? m.chanVols[src] / 64 : 1, inst: 0, smp: -1, midi: 60, period: 0, target: 0, vol: 0, pan: m.pans[src], key: false, fade: 65536,
    env: 0, penv: 0, vib: [0, 0, 0], trem: [0, 0, 0], mem: {}, loopRow: 0, loopLeft: 0, tremor: 0, retrig: 0, offset: 0, cut: false }));
  const flat = keep.map(() => ({ events: new Map(), loopTick: -1, endTick: 0 }));
  const last = keep.map(() => ({ smp: null, vol: null, bend: 0, pan: null }));
  let speed = m.speed, tempo = m.tempo, gvol = m.globalVolume, pos = 0, row = 0, tick = 0, tempoChange = null, loopTick = -1;
  const order = m.order.filter((pi) => m.pats[pi]), entered = new Map([[0, 0]]);
  const memo = (ch, k, v) => (v ? (ch.mem[k] = v) : ch.mem[k] || 0);
  const step = (ch, cl, t, rep) => {                   // one tick of one channel
    const fx = cl ? cl.fx : TM_NONE, prm = cl ? cl.prm : 0, x = prm >> 4, y = prm & 15, first = t === 0 && rep === 0;
    let trigger = false, start = 0;
    const delay = fx === 0xE && x === 0xD ? y : 0, porta = fx === 3 || fx === 5 || (cl && cl.volfx >> 4 === 0xF);
    if (cl && t === delay && rep === 0) {
      if (cl.pan !== undefined) ch.pan = cl.pan;
      if (cl.cv !== undefined) ch.cv = cl.cv / 64;
      if (cl.inst) {
        ch.inst = cl.inst;
        const s = m.samples[tmSampleFor(m, ch.inst, typeof cl.note === 'number' ? cl.note : ch.midi)];
        if (s) { ch.vol = s.volume; if (s.pan !== null && s.pan !== undefined) ch.pan = s.pan; }
        ch.fade = 65536; ch.env = 0; ch.penv = 0; ch.key = true;
      }
      if (cl.note === 'off') {
        ch.key = false;
        const ins = m.instruments[ch.inst - 1];
        if (!(ins && ins.env)) ch.vol = 0;
      } else if (typeof cl.note === 'number') {
        const smp = tmSampleFor(m, ch.inst, cl.note), s = m.samples[smp];
        if (s && s.frames) {
          const per = tmPeriod(m, s, cl.note);
          if (porta && ch.period) ch.target = per;
          else {
            ch.smp = smp; ch.midi = cl.note; ch.period = per; ch.target = 0; ch.vib[2] = ch.trem[2] = 0;
            ch.key = true; ch.fade = 65536; ch.env = 0; ch.penv = 0; ch.cut = false;
            trigger = true; start = fx === 9 ? memo(ch, 'o', prm) : 0;
          }
        }
      }
      if (cl.vol !== null) ch.vol = cl.vol;
    }
    if (first && cl) {
      const vf = cl.volfx, vx = vf >> 4, vy = vf & 15;
      if (vx === 0x8) ch.vol = Math.max(0, ch.vol - vy);
      else if (vx === 0x9) ch.vol = Math.min(64, ch.vol + vy);
      else if (vx === 0xA) ch.vib[0] = vy;
      else if (vx === 0xB) ch.vib[1] = vy;
      else if (vx === 0xC) ch.pan = vy * 17;
      else if (vx === 0xF && vy) ch.mem.p = vy * 16;
      if (fx === 0xC) ch.vol = Math.min(64, prm);
      else if (fx === 0x8) ch.pan = prm;
      else if (fx === 0x3) memo(ch, 'p', prm);
      else if (fx === 0x4) { if (x) ch.vib[0] = x; if (y) ch.vib[1] = y; }
      else if (fx === 0x7) { if (x) ch.trem[0] = x; if (y) ch.trem[1] = y; }
      else if (fx === TM.G) gvol = Math.min(64, prm);
      else if (fx === TM.X) { const v = memo(ch, x === 1 ? 'xu' : 'xd', y); ch.period += x === 1 ? -v : v; }
      else if (fx === 0xE) {
        if (x === 1) ch.period -= 4 * memo(ch, 'fu', y);
        else if (x === 2) ch.period += 4 * memo(ch, 'fd', y);
        else if (x === 0xA) ch.vol = Math.min(64, ch.vol + memo(ch, 'va', y));
        else if (x === 0xB) ch.vol = Math.max(0, ch.vol - memo(ch, 'vb', y));
        else if (x === 8) ch.pan = y * 17;
      }
      if (fx === 0xA && m.fastSlides) { const v = memo(ch, 'v', prm), a = v >> 4, b = v & 15; ch.vol = a ? Math.min(64, ch.vol + a) : Math.max(0, ch.vol - b); }
    }
    if (fx === 0xE && x === 0xC && t === y) ch.vol = 0;
    if (fx === TM.K && t === prm) { ch.key = false; const ins = m.instruments[ch.inst - 1]; if (!(ins && ins.env)) ch.vol = 0; }
    if (fx === 0xE && x === 9 && y && t && t % y === 0 && ch.smp >= 0) trigger = true;
    if (fx === TM.R) { const v = memo(ch, 'r', prm), iv = v & 15; if (iv && t && t % iv === 0 && ch.smp >= 0) trigger = true; }
    let period = ch.period, arp = 0;
    if (t) {
      if (fx === 0x1) ch.period = period = ch.period - 4 * memo(ch, 'u', prm);
      else if (fx === 0x2) ch.period = period = ch.period + 4 * memo(ch, 'd', prm);
      if ((fx === 0x3 || fx === 0x5 || (cl && cl.volfx >> 4 === 0xF)) && ch.target) {
        const sp = 4 * (ch.mem.p || 0);
        ch.period = ch.period < ch.target ? Math.min(ch.target, ch.period + sp) : Math.max(ch.target, ch.period - sp);
        period = ch.period;
      }
      const slideVol = (v) => { const a = v >> 4, b = v & 15; ch.vol = a ? Math.min(64, ch.vol + a) : Math.max(0, ch.vol - b); };
      if (fx === 0xA || fx === 0x5 || fx === 0x6) slideVol(memo(ch, 'v', fx === 0xA ? prm : prm));
      if (cl && cl.volfx >> 4 === 0x6) ch.vol = Math.max(0, ch.vol - (cl.volfx & 15));
      if (cl && cl.volfx >> 4 === 0x7) ch.vol = Math.min(64, ch.vol + (cl.volfx & 15));
      if (fx === TM.H) { const v = memo(ch, 'g', prm), a = v >> 4, b = v & 15; gvol = a ? Math.min(64, gvol + a) : Math.max(0, gvol - b); }
      if (fx === TM.P) { const v = memo(ch, 'pp', prm), a = v >> 4, b = v & 15; ch.pan = a ? Math.min(255, ch.pan + a) : Math.max(0, ch.pan - b); }
      if (fx === 0x4 || fx === 0x6 || (cl && cl.volfx >> 4 === 0xB)) {
        const [sp, depth, p] = ch.vib, delta = MOD_SINE[p & 31] * depth >> 5;
        period = ch.period + (p & 32 ? -delta : delta);
        ch.vib[2] = (p + sp) & 63;
      }
    }
    let vol = ch.vol;
    if (t && fx === 0x7) {
      const [sp, depth, p] = ch.trem, delta = MOD_SINE[p & 31] * depth >> 6;
      vol = Math.max(0, Math.min(64, ch.vol + (p & 32 ? -delta : delta)));
      ch.trem[2] = (p + sp) & 63;
    }
    if (fx === TM.T) { const v = memo(ch, 't', prm), on = (v >> 4) + 1, off = (v & 15) + 1; if ((ch.tremor++ % (on + off)) >= on) vol = 0; }
    if (fx === 0x0 && prm) arp = [0, x, y][t % 3];
    // the instrument's envelope and fade-out (XM)
    const ins = m.instruments[ch.inst - 1];
    let envv = 1, pan = ch.pan;
    if (ins && ins.env) {
      const e = ins.env, pts = e.points;
      envv = tmEnvValue(e, ch.env) / 64;
      const sus = e.sustain >= 0 && ch.key ? pts[Math.min(e.sustain, pts.length - 1)][0] : -1;
      if (!(sus >= 0 && ch.env >= sus)) {
        ch.env++;
        if (e.loop && ch.env >= pts[Math.min(e.loop[1], pts.length - 1)][0]) ch.env = pts[Math.min(e.loop[0], pts.length - 1)][0];
      }
      if (!ch.key) ch.fade = Math.max(0, ch.fade - ins.fadeout);
    }
    if (ins && ins.panEnv) {
      const pe = tmEnvValue(ins.panEnv, ch.penv);
      pan = Math.max(0, Math.min(255, ch.pan + (pe - 32) * (128 - Math.abs(ch.pan - 128)) / 32));
      ch.penv++;
    }
    const level = vol * envv * (ch.fade / 65536) * gvol / 64 * ch.cv;
    const s = m.samples[ch.smp];
    let bend = 0;
    if (s && period > 0) bend = Math.round(1200 * Math.log2(tmFreq(m, period) / tmRate(m, s)) - (ch.midi - 60) * 100) + 100 * arp;
    return [trigger, ch.smp, ch.midi, Math.max(-32768, Math.min(32767, bend)), level, start, Math.round(pan) - 128];
  };
  const emit = (c, out) => {
    const [trigger, smp, midi, b, level, start, p] = out, L = last[c], cmds = [];
    const add = (op, ...args) => cmds.push({ op, args: Uint8Array.from(args) });
    if (tempoChange && c === 0) add(CH.TEMPO, tempoChange & 0xFF, tempoChange >> 8);
    if (p !== L.pan) { add(CH.POSITION, p & 0xFF, 0); L.pan = p; }
    if (trigger && smp >= 0) {
      if (smp !== L.smp) { add(CH.INSTRUMENT, smp); L.smp = smp; }
      if (start) add(CH.SAMPLE_START, start & 0xFF, start >> 8);
      add(CH.NOTE, Math.max(0, Math.min(127, midi)));
      L.bend = 0;
    }
    const v = modVolume(level);
    if (v !== L.vol) { add(CH.VOLUME, v); L.vol = v; }
    if (L.smp !== null && b !== L.bend) { add(CH.BEND, b & 0xFF, (b >> 8) & 0xFF); L.bend = b; }
    if (cmds.length) flat[c].events.set(tick, cmds);
  };
  for (let guard = 0; pos < order.length && guard < 200000; guard++) {
    const pat = m.pats[order[pos]], cells = keep.map((src) => (row < pat.rows ? pat.cells[row][src] : null));
    let delayRows = 0, jump = null, brk = null, loopTo = null;
    cells.forEach((cl, c) => {
      if (!cl) return;
      const x = cl.prm >> 4, y = cl.prm & 15;
      if (cl.fx === TM.SPEED) speed = cl.prm;
      else if (cl.fx === TM.TEMPO) tempo = tempoChange = cl.prm;
      else if (cl.fx === 0xB) jump = cl.prm;
      else if (cl.fx === TM.BREAK) brk = cl.prm;
      else if (cl.fx === 0xE && x === 0xE) delayRows = y;
      else if (cl.fx === 0xE && x === 6) {
        const ch = chans[c];
        if (y === 0) ch.loopRow = row;
        else if (ch.loopLeft === 0) { ch.loopLeft = y; loopTo = ch.loopRow; }
        else { ch.loopLeft--; if (ch.loopLeft) loopTo = ch.loopRow; }
      } else if (cl.fx === TM.L) note('envelope position');
    });
    for (let rep = 0; rep <= delayRows; rep++)
      for (let t = 0; t < speed; t++) {
        cells.forEach((cl, c) => emit(c, step(chans[c], cl, t, rep)));
        tempoChange = null;
        tick++;
      }
    if (loopTo !== null) { row = loopTo; continue; }
    if (jump !== null || brk !== null) {
      pos = jump !== null ? jump : pos + 1;
      row = brk !== null ? brk : 0;
    } else if (++row >= pat.rows) { row = 0; pos++; }
    else continue;
    if (pos >= order.length) {
      if (m.kind === 'xm' && m.restart < order.length) { if (entered.has(m.restart)) loopTick = entered.get(m.restart); }
      break;
    }
    if (entered.has(pos)) { if (row === 0) loopTick = entered.get(pos); break; }   // the module loops from here
    if (row === 0) entered.set(pos, tick);
  }
  for (const f of flat) { f.endTick = tick; f.loopTick = loopTick; }
  song.tpb = 24; song.bpm = m.tempo;
  const out = bestEffort(song, flat, true);
  out.lost = [...(m.lost || []), ...(missing || [])];
  out.notes.unshift(`A ${m.packedFrom || m.nch}-channel ${tmLabel(m)} module, played tick by tick.`, ...m.notes.map((n) => n[0].toUpperCase() + n.slice(1) + '.'));
  if (dropped) out.notes.push(`${dropped} channels beyond 16 dropped (${lost} notes).`);
  if (ignored.size) out.notes.push('Not carried over: ' + [...ignored].map(([k, n]) => `${k} ×${n}`).join(', ') + '.');
  return out;
}

// An S3M, XM or IT file as a song: best effort, or with options.exact played tick by tick.
export function readTracked(buf, options = {}) {
  const b = new Uint8Array(buf), read = isXm(b) ? readXm(buf) : isIt(b) ? readIt(buf) : readS3m(buf);
  const m = read.nch > 16 && options.pack !== false ? tmPack(read) : read;
  return options.exact ? tmExact(m) : tmPatterns(m);
}
