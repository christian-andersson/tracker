// SPDX-License-Identifier: GPL-3.0-only
// ProTracker modules (.mod): read as patterns, or played as ProTracker
// plays them.

import { CH, INSTRUMENT_SIZE } from './format.js';
import { WAVE_SAMPLE, setU32 } from './waves.js';
import { bestEffort, cellEmpty, emptyCell, newPattern } from './song.js';

// ---------------------------------------------------------------- ProTracker modules (.mod)

// A module opens like a song without tracker data (as the command-line
// converter converters/mod2rsng.js converts it): one instrument per
// sample, playing it on its fourth operator, 8-bit, without smoothing as on
// the Amiga (OP_SAMPLE_NEAREST). Best effort keeps the module's patterns
// and order, its effects on the effect column or as extra commands where
// the song player has one; exact import plays it the way ProTracker does,
// tick by tick, and lays that on one tick a row.
export const MOD_PERIODS = [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113];
export const MOD_SINE = [0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24];
export const PAL_CLOCK = 3546894.6, MOD_ROOT_PERIOD = 428, MOD_ROOT_NOTE = 60, MOD_PAN = [-64, 64, 64, -64];
export const OP_SAMPLE_NEAREST = 8;
export const modVolume = (v) => Math.round(255 * Math.sqrt(Math.max(0, Math.min(64, v)) / 64));
export const modNote = (per) => {               // the nearest note of the period table, as MIDI
  let best = 0;
  for (let i = 1; i < MOD_PERIODS.length; i++) if (Math.abs(MOD_PERIODS[i] - per) < Math.abs(MOD_PERIODS[best] - per)) best = i;
  return MOD_ROOT_NOTE - 12 + best;
};
export const modCents = (per) => 1200 * Math.log2(MOD_ROOT_PERIOD / per);

export function modChannels(tag) {
  if (['M.K.', 'M!K!', 'FLT4', '4CHN'].includes(tag)) return 4;
  if (['OCTA', 'CD81', 'FLT8'].includes(tag)) return 8;
  if (/^[1-9]CHN$/.test(tag)) return +tag[0];
  if (/^[0-9]{2}CH$/.test(tag)) return +tag.slice(0, 2);
  return 0;
}
export const isMod = (bytes) => bytes.length >= 1084 && (modChannels(String.fromCharCode(...bytes.subarray(1080, 1084))) > 0 ||
  modChannels(String.fromCharCode(bytes[1081], bytes[1080], bytes[1083], bytes[1082])) > 0);

// The module's parts. Damaged copies can have the bytes of each 16-bit word
// swapped (".M.K"), sometimes only in part: the header and each pattern are
// read the way that looks like music.
export function readModFile(buf) {
  const d = new Uint8Array(buf).slice(), notes = [];
  const swap = (a, b) => { for (let i = a; i + 1 < b; i += 2) { const t = d[i]; d[i] = d[i + 1]; d[i + 1] = t; } };
  const tag = () => String.fromCharCode(...d.subarray(1080, 1084));
  if (d.length < 1084) throw new Error('too short for a module');
  if (!modChannels(tag())) {
    swap(0, 1084);
    if (!modChannels(tag())) throw new Error('not a 31-sample module');
    notes.push('header');
  }
  const nch = modChannels(tag());
  if (nch > 16) throw new Error(`${nch} channels; the song player has 16 voices`);
  const text = (a, n) => String.fromCharCode(...d.subarray(a, a + n)).replace(/\0.*$/s, '').replace(/[^\x20-\x7e]/g, ' ').trim();
  const u16 = (o) => d[o] << 8 | d[o + 1];
  const samples = [];
  for (let i = 0; i < 31; i++) {
    const o = 20 + 30 * i, ft = d[o + 24] & 15, ll = u16(o + 28);
    samples.push({ name: text(o, 22), length: u16(o + 22) * 2, finetune: ft & 8 ? ft - 16 : ft, volume: Math.min(d[o + 25], 64),
      loopStart: u16(o + 26) * 2, loopLength: ll > 1 ? ll * 2 : 0 });
  }
  const order = Array.from(d.subarray(952, 952 + Math.min(128, d[950])));
  const npat = Math.max(...d.subarray(952, 1080)) + 1, patBytes = 64 * 4 * nch;
  const plausible = (a) => {
    let score = 0;
    for (let i = a; i < a + patBytes; i += 4) {
      const per = (d[i] & 15) << 8 | d[i + 1], smp = (d[i] & 0xF0) | d[i + 2] >> 4;
      if (per || smp) score += smp <= 31 && (per === 0 || (per >= 108 && per <= 907)) ? 1 : -1;
    }
    return score;
  };
  let at = 1084;
  const pats = [];
  for (let p = 0; p < npat; p++) {
    if (at + patBytes > d.length) throw new Error('the file ends inside its patterns');
    const plain = plausible(at);
    swap(at, at + patBytes);
    if (plausible(at) > plain) notes.push('pattern ' + p); else swap(at, at + patBytes);
    const rows = [];
    for (let r = 0; r < 64; r++) {
      const row = [];
      for (let c = 0; c < nch; c++) {
        const i = at + (r * nch + c) * 4;
        row.push({ smp: (d[i] & 0xF0) | d[i + 2] >> 4, per: (d[i] & 15) << 8 | d[i + 1], fx: d[i + 2] & 15, prm: d[i + 3] });
      }
      rows.push(row);
    }
    pats.push(rows);
    at += patBytes;
  }
  for (const sm of samples) {
    sm.data = d.slice(at, Math.min(d.length, at + sm.length));
    at += sm.length;
    sm.length = sm.data.length;                     // a cut-off file has shorter samples
    if (sm.loopStart + sm.loopLength > sm.length) sm.loopLength = Math.max(0, sm.length - sm.loopStart);
  }
  if (notes.length) notes.unshift('Bytes swapped in pairs in the ' + notes.splice(0).join(', ') + ', read swapped back.');
  return { name: text(0, 20), nch, samples, order, pats, notes };
}

// One instrument and one sample wave per module sample. With `finetune`, a
// sample's finetune goes into its rate (best effort plays notes, not periods).
export function modInstruments(m, song, finetune) {
  m.samples.forEach((sm, i) => {
    const rate = PAL_CLOCK / MOD_ROOT_PERIOD * (finetune ? 2 ** (sm.finetune / 96) : 1);
    song.waves.push({ kind: 'sample', name: sm.name, frames: sm.length, loopStart: sm.loopStart, loopLength: sm.loopLength,
      rate: Math.round(rate), root: MOD_ROOT_NOTE, format: 1, data: sm.data });
    const b = new Uint8Array(INSTRUMENT_SIZE), o = 60;
    b[o] = WAVE_SAMPLE; b[o + 1] = 2; b[o + 3] = 255; b[o + 6] = OP_SAMPLE_NEAREST;
    b[o + 12] = 0; b[o + 13] = 0; b[o + 14] = 255; b[o + 15] = 32;
    setU32(b, o + 16, i);
    b[80] = 7; b[82] = 255;
    song.instruments.push({ name: sm.name || `Sample ${i + 1}`, bytes: b });
  });
}

export function modSong(m) {
  return { name: m.name, auth: '', licn: '', desc: 'ProTracker module', date: '', bpm: 125, tpb: 24, channels: m.nch,
    voices: Array.from({ length: 16 }, (_, i) => (i < m.nch ? i : 0)), instruments: [], waves: [], patterns: [], order: [],
    loop: -1, notes: [], ticksPerRow: 6, rowsPerBeat: 4 };
}

// Best effort: the module's own patterns and order.
export function modPatterns(m) {
  const song = modSong(m), ignored = new Map(), note = (k) => ignored.set(k, (ignored.get(k) || 0) + 1);
  modInstruments(m, song, true);
  // speed and tempo as the song starts, and the rows each pattern really has (Dxx)
  let speed = 6, tempo = 125;
  for (const c of m.pats[m.order[0]][0]) if (c.fx === 0xF && c.prm) { if (c.prm < 32) speed = c.prm; else tempo = c.prm; }
  song.ticksPerRow = speed; song.bpm = tempo;
  song.rowsPerBeat = Math.max(1, Math.round(song.tpb / speed));
  const rows = m.pats.map((p) => {
    for (let r = 0; r < 64; r++) if (p[r].some((c) => c.fx === 0xD)) {
      if (p[r].some((c) => c.fx === 0xD && c.prm)) note('Dxx to a row other than 0');
      return r + 1;
    }
    return 64;
  });
  song.order = m.order.slice();
  // Bxx: a jump back is the song's loop
  m.order.some((pi, k) => m.pats[pi].slice(0, rows[pi]).some((row) => row.some((c) => {
    if (c.fx !== 0xB) return false;
    if (c.prm <= k) { song.loop = c.prm; song.order = song.order.slice(0, k + 1); return true; }
    note('Bxx forward'); return false;
  })));
  // tempo along the order (speed changes become tempo changes: the rows keep their length)
  const used = new Set(song.order);
  const tps = () => tempo * song.tpb / 60;
  song.patterns = m.pats.map((p, pi) => {
    const pat = newPattern(rows[pi], m.nch);
    const last = Array.from({ length: m.nch }, () => ({ per: MOD_ROOT_PERIOD, porta: 0, vib: [0, 0] }));
    for (let r = 0; r < rows[pi]; r++) for (let ch = 0; ch < m.nch; ch++) {
      const { smp, per, fx, prm } = p[r][ch], x = prm >> 4, y = prm & 15, c = emptyCell(), l = last[ch];
      if (per) { c.note = modNote(per); }
      if (smp && smp <= 31) { c.inst = smp - 1; c.vol = modVolume(m.samples[smp - 1].volume); }
      const at = per || l.per;
      switch (fx) {
        case 0x0: if (prm) { c.fx = 0; c.param = prm; } break;
        case 0x1: if (prm) { c.fx = 1; c.param = Math.min(255, Math.max(1, Math.round(1200 * Math.log2(at / Math.max(113, at - prm))))); } break;
        case 0x2: if (prm) { c.fx = 2; c.param = Math.min(255, Math.max(1, Math.round(1200 * Math.log2((at + prm) / at)))); } break;
        case 0x3: case 0x5: {
          if (fx === 3 && prm) l.porta = prm;
          if (fx === 5) note('5xy (as Axy, the slide carries on)');
          if (fx === 3 && per) {            // a slide to the note, the speed in cents a tick at the note
            c.fx = 3; c.param = Math.min(255, Math.max(1, Math.round(1200 * Math.log2((per + (l.porta || 1)) / per))));
          } else if (fx === 5) { c.fx = 10; c.param = x ? Math.min(15, x * 4) << 4 : Math.min(15, y * 4); }
          if (per) c.note = modNote(per);
          break;
        }
        case 0x4: case 0x6: {
          if (fx === 4) { if (x) l.vib[0] = x; if (y) l.vib[1] = y; }
          if (fx === 6) { note('6xy (as Axy, the vibrato stops)'); c.fx = 10; c.param = x ? Math.min(15, x * 4) << 4 : Math.min(15, y * 4); break; }
          const depth = 1731 * 2 * l.vib[1] / at, hz = l.vib[0] * tps() / 64;
          c.fx = 4; c.param = Math.max(1, Math.min(15, Math.round(depth / 8))) << 4 | Math.max(1, Math.min(15, Math.round(hz)));
          break;
        }
        case 0x7: note('7xy tremolo'); break;
        case 0x8: c.raw.push(Uint8Array.of(CH.POSITION, (prm - 128) & 0xFF, 0)); break;
        case 0x9: if (prm) c.raw.push(Uint8Array.of(CH.SAMPLE_START, prm, 0)); break;
        case 0xA: if (prm) { c.fx = 10; c.param = x ? Math.min(15, x * 4) << 4 : Math.min(15, y * 4); } break;
        case 0xB: case 0xD: break;
        case 0xC: c.vol = modVolume(prm); break;
        case 0xE:
          if (x === 0xC && y === 0 && !per) c.off = true;
          else if (x !== 0) note(`E${x.toString(16).toUpperCase()}x`);
          break;
        case 0xF:
          if (prm) {
            if (prm < 32) speed = prm; else tempo = prm;
            if (!(pi === m.order[0] && r === 0)) { c.fx = 15; c.param = Math.min(255, Math.round(tempo * song.ticksPerRow / speed)); }
          }
          break;
        default: break;
      }
      if (per) l.per = per;
      if (!cellEmpty(c)) pat.cells[ch][r] = c;
    }
    return pat;
  });
  // the Amiga's channels: left, right, right, left, set on the first row
  const first = song.patterns[song.order[0]];
  for (let ch = 0; ch < m.nch; ch++) {
    const c = first.cells[ch][0] || emptyCell();
    c.raw.unshift(Uint8Array.of(CH.POSITION, MOD_PAN[ch % 4] & 0xFF, 0));
    first.cells[ch][0] = c;
  }
  song.patterns.forEach((p, pi) => { p.name = used.has(pi) ? `pattern ${pi}` : `pattern ${pi} (unused)`; });
  song.notes = [`A ${m.nch}-channel module: its patterns and order, the effects approximated.`, ...m.notes];
  if (ignored.size) song.notes.push('Not carried over: ' + [...ignored].map(([k, n]) => `${k} ×${n}`).join(', ') + '.');
  return song;
}

// Exact: ProTracker's playback, each channel's commands by tick.
export function modExact(m) {
  const song = modSong(m), ignored = new Map(), note = (k) => ignored.set(k, (ignored.get(k) || 0) + 1);
  modInstruments(m, song, false);
  const chans = Array.from({ length: m.nch }, (_, c) => ({ sample: 0, volume: 64, period: 0, finetune: 0, note: MOD_ROOT_NOTE,
    target: 0, portaSpeed: 0, vib: [0, 0, 0], trem: [0, 0, 0], offset: 0, loopRow: 0, loopLeft: 0, pan: MOD_PAN[c % 4] }));
  const flat = Array.from({ length: m.nch }, () => ({ events: new Map(), loopTick: -1, endTick: 0 }));
  const last = Array.from({ length: m.nch }, () => ({ sample: null, volume: null, bend: 0, pan: null }));
  let speed = 6, tempo = 125, pos = 0, row = 0, tick = 0, tempoChange = null;
  const entered = new Map([[0, 0]]);
  let loopTick = -1;
  const emit = (c, out) => {
    const [trigger, smp, nt, b, vol, start, p] = out, L = last[c], cmds = [];
    const add = (op, ...args) => cmds.push({ op, args: Uint8Array.from(args) });
    if (tempoChange && c === 0) add(CH.TEMPO, tempoChange & 0xFF, tempoChange >> 8);
    if (p !== L.pan) { add(CH.POSITION, p & 0xFF, 0); L.pan = p; }
    if (trigger && smp) {
      if (smp !== L.sample) { add(CH.INSTRUMENT, smp - 1); L.sample = smp; }
      if (start) add(CH.SAMPLE_START, start & 0xFF, start >> 8);
      add(CH.NOTE, nt);
      L.bend = 0;
    }
    const v = modVolume(vol);
    if (v !== L.volume) { add(CH.VOLUME, v); L.volume = v; }
    if (L.sample !== null && b !== L.bend) { add(CH.BEND, b & 0xFF, (b >> 8) & 0xFF); L.bend = b; }
    if (cmds.length) flat[c].events.set(tick, cmds);
  };
  for (let guard = 0; pos < m.order.length && guard < 100000; guard++) {
    const cells = m.pats[m.order[pos]][row];
    let delayRows = 0, jump = null, brk = null, loopTo = null;
    cells.forEach((cl, c) => {
      const { fx, prm } = cl, x = prm >> 4, y = prm & 15;
      if (fx === 0xF && prm) { if (prm < 32) speed = prm; else tempo = tempoChange = prm; }
      else if (fx === 0xB) jump = prm;
      else if (fx === 0xD) brk = x * 10 + y;
      else if (fx === 0xE && x === 0xE) delayRows = y;
      else if (fx === 0xE && x === 6) {
        const ch = chans[c];
        if (y === 0) ch.loopRow = row;
        else if (ch.loopLeft === 0) { ch.loopLeft = y; loopTo = ch.loopRow; }
        else { ch.loopLeft--; if (ch.loopLeft) loopTo = ch.loopRow; }
      } else if (fx === 0xE && [0, 4, 7, 0xF].includes(x)) note(`E${x.toString(16).toUpperCase()}x`);
      else if (fx === 7 && false) note('');
    });
    for (let rep = 0; rep <= delayRows; rep++)
      for (let t = 0; t < speed; t++) {
        cells.forEach((cl, c) => emit(c, modTick(chans[c], m.samples, cl, t, rep)));
        tempoChange = null;
        tick++;
      }
    if (loopTo !== null) { row = loopTo; continue; }
    if (jump !== null || brk !== null) {
      const npos = jump !== null ? jump : pos + 1;
      row = brk !== null && brk < 64 ? brk : 0;
      pos = npos;
    } else {
      row++;
      if (row < 64) continue;
      row = 0; pos++;
    }
    if (pos >= m.order.length) break;
    if (entered.has(pos)) { if (row === 0) loopTick = entered.get(pos); break; }   // the module loops from here
    if (row === 0) entered.set(pos, tick);
  }
  for (const f of flat) { f.endTick = tick; f.loopTick = loopTick; }
  song.tpb = 24; song.bpm = 125;
  const out = bestEffort(song, flat, true);
  out.notes.unshift(`A ${m.nch}-channel module, played as ProTracker plays it.`, ...m.notes);
  if (ignored.size) out.notes.push('Not carried over: ' + [...ignored].map(([k, n]) => `${k} ×${n}`).join(', ') + '.');
  return out;
}

// One tick of one channel: what it plays.
export function modTick(ch, samples, cl, tick, rep) {
  const { smp, per, fx, prm } = cl, x = prm >> 4, y = prm & 15;
  let trigger = false, start = 0;
  const first = tick === 0 && rep === 0, delay = fx === 0xE && x === 0xD ? y : 0, porta = fx === 3 || fx === 5;
  if (first && fx === 9 && prm) ch.offset = prm;
  if (tick === delay && rep === 0 && (smp || per)) {
    if (smp && smp <= 31) { ch.sample = smp; ch.volume = samples[smp - 1].volume; ch.finetune = samples[smp - 1].finetune; }
    if (per) {
      const fine = per * 2 ** (-ch.finetune / 96);
      if (porta) ch.target = fine;
      else {
        ch.period = fine; ch.note = modNote(per); ch.vib[2] = ch.trem[2] = 0;
        trigger = true; start = fx === 9 ? ch.offset : 0;
      }
    }
  }
  if (fx === 0xE && x === 9 && y && tick && tick % y === 0 && ch.period) trigger = true;
  if (first) {
    if (fx === 0xC) ch.volume = Math.min(prm, 64);
    else if (fx === 8) ch.pan = prm - 128;
    else if (fx === 0xE) {
      if (x === 1) ch.period = Math.max(113, ch.period - y);
      else if (x === 2) ch.period = Math.min(856, ch.period + y);
      else if (x === 5) ch.finetune = y & 8 ? y - 16 : y;
      else if (x === 8) ch.pan = y * 17 - 128;
      else if (x === 0xA) ch.volume = Math.min(64, ch.volume + y);
      else if (x === 0xB) ch.volume = Math.max(0, ch.volume - y);
    }
    if (fx === 3 && prm) ch.portaSpeed = prm;
    if (fx === 4) { if (x) ch.vib[0] = x; if (y) ch.vib[1] = y; }
    if (fx === 7) { if (x) ch.trem[0] = x; if (y) ch.trem[1] = y; }
  }
  if (fx === 0xE && x === 0xC && tick === y) ch.volume = 0;
  let period = ch.period, volume = ch.volume, arp = 0;
  if (tick) {
    if (fx === 1) ch.period = period = Math.max(113, ch.period - prm);
    else if (fx === 2) ch.period = period = Math.min(856, ch.period + prm);
    if ((fx === 3 || fx === 5) && ch.target && ch.period) {
      ch.period = ch.period < ch.target ? Math.min(ch.target, ch.period + ch.portaSpeed) : Math.max(ch.target, ch.period - ch.portaSpeed);
      period = ch.period;
    }
    if (fx === 5 || fx === 6 || fx === 0xA) ch.volume = volume = x ? Math.min(64, ch.volume + x) : Math.max(0, ch.volume - y);
    if (fx === 4 || fx === 6) {
      const [sp, depth, p] = ch.vib, delta = MOD_SINE[p & 31] * depth >> 7;
      period = ch.period + (p & 32 ? -delta : delta);
      ch.vib[2] = (p + sp) & 63;
    }
    if (fx === 7) {
      const [sp, depth, p] = ch.trem, delta = MOD_SINE[p & 31] * depth >> 6;
      volume = Math.max(0, Math.min(64, ch.volume + (p & 32 ? -delta : delta)));
      ch.trem[2] = (p + sp) & 63;
    }
  }
  if (fx === 0 && prm) arp = [0, x, y][tick % 3];
  let bend = 0;
  if (period) bend = Math.round(modCents(period) - (ch.note - MOD_ROOT_NOTE) * 100) + 100 * arp;
  return [trigger, ch.sample, ch.note, Math.max(-32768, Math.min(32767, bend)), volume, start, ch.pan];
}

export function readMod(buf, options = {}) {
  const m = readModFile(buf);
  return options.exact ? modExact(m) : modPatterns(m);
}
