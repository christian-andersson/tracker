// SPDX-License-Identifier: GPL-3.0-only
// Chasing: what each channel has in force where an order position (or a
// row) starts, worked out the way the song player gets there, and a play
// from there.

import { CH, INSTRUMENT_SIZE } from './format.js';
import { i16, phraseBytes, phraseEvents, s16, u16, writeSong } from './song.js';

// ---------------------------------------------------------------- chasing

// What each channel has in force when an order position starts, worked
// out the way the song player (song.c) would arrive there: instrument,
// volume (volume slides run tick by tick), note length, legato, tuning,
// position, vibrato, arpeggio, patches, running sweeps with their value
// and direction at that tick, a pending sample start, and the tempo. A
// note still sounding from the position before is not part of it.
//
// Each position's state is the state the position before ended with, so
// a position is worked out again only when its pattern or what came
// before it changed: `cache` keeps each one's patterns, start and end.
export function freshChannel() {
  return { inst: 0, vol: 255, len: 0, legato: 0, fine: 0, x: 0, y: 0, vstep: 0, vib: [0, 0, 0], arp: [0],
    start: 0, sweeps: [], patch: {} };
}
export const s8 = (v) => (v >= 0x80 ? v - 0x100 : v);
export const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function sweepWrite(c, w) {
  if (w.word) { c.patch[w.offset] = w.value & 0xFF; c.patch[w.offset + 1] = (w.value >> 8) & 0xFF; }
  else c.patch[w.offset] = (w.value >> 8) & 0xFF;
}

export function chaseCommand(c, g, op, a) {
  switch (op) {
    case CH.NOTE: c.start = 0; break;
    case CH.INSTRUMENT:
      c.inst = a[0]; c.patch = {};
      for (const w of c.sweeps) if (w.mode) sweepWrite(c, w);
      break;
    case CH.PATCH:
      if (a[0] >= INSTRUMENT_SIZE) break;
      for (const w of c.sweeps) if (w.mode && (w.offset === a[0] || (w.word && w.offset + 1 === a[0]))) w.mode = 0;
      c.patch[a[0]] = a[1];
      break;
    case CH.SWEEP: {
      const offset = a[0], start = a[1] | a[2] << 8, step = i16(a, 3), low = a[5], high = a[6];
      const word = a[7] & 0x80 ? 1 : 0, mode = a[7] & 0x7F;
      if (offset + word >= INSTRUMENT_SIZE || mode > 2 || low > high) break;
      while (c.sweeps.length < 2) c.sweeps.push({ mode: 0 });
      let w = c.sweeps.find((x) => x.mode && x.offset === offset) || c.sweeps.find((x) => !x.mode);
      if (!w) break;
      w.mode = mode;
      if (!mode) break;
      Object.assign(w, { word, offset, low, high, step, value: clampI(start, low << 8, high << 8 | 0xFF) });
      sweepWrite(c, w);
      break;
    }
    case CH.ARPEGGIO: c.arp = a[0] ? Array.from(a) : [0]; break;
    case CH.SAMPLE_START: c.start = a[0] | a[1] << 8; break;
    case CH.VOLUME: c.vol = a[0]; break;
    case CH.LENGTH: c.len = a[0] | a[1] << 8; break;
    case CH.LEGATO: c.legato = a[0] ? 1 : 0; break;
    case CH.VIBRATO: c.vib = [a[0], a[1], a[2]]; break;
    case CH.VOLUME_SLIDE: c.vstep = s8(a[0]); break;
    case CH.POSITION: c.x = s8(a[0]); c.y = s8(a[1]); break;
    case CH.FINE: c.fine = s8(a[0]); break;
    case CH.TEMPO: { const b = a[0] | a[1] << 8; if (b) g.bpm = b; break; }
    default: break;
  }
}

export function chaseTick(c) {
  if (c.vstep) c.vol = clampI(c.vol + c.vstep, 0, 255);
  for (const w of c.sweeps) {
    if (!w.mode) continue;
    const lo = w.low << 8, hi = w.high << 8;
    let v = w.value + w.step;
    if (w.mode === 1) {
      const span = hi - lo + 256;
      while (v >= hi + 256) v -= span;
      while (v < lo) v += span;
    } else {
      if (v > hi) { v = 2 * hi - v; w.step = -w.step; }
      if (v < lo) { v = 2 * lo - v; w.step = -w.step; }
      v = clampI(v, lo, hi | 0xFF);
    }
    w.value = v;
    sweepWrite(c, w);
  }
}

// The state after one order position (or its first `upto` ticks), from the
// state it started with.
export function chasePosition(song, pattern, phrases, state, upto = pattern.rows * song.ticksPerRow) {
  const g = JSON.parse(JSON.stringify(state));
  const events = phrases.map((b) => phraseEvents(b, 0)), ticks = upto;
  for (let t = 0; t < ticks; t++)
    g.ch.forEach((c, ch) => {
      for (const e of (events[ch] && events[ch].get(t)) || []) chaseCommand(c, g, e.op, e.args);
      chaseTick(c);
    });
  for (const c of g.ch) c.sweeps = c.sweeps.filter((w) => w.mode);
  return g;
}

// The state at the start of every order position, and at the end of the
// last (states[order.length]).
export function chase(song, cache = {}) {
  let state = { bpm: song.bpm, ch: Array.from({ length: song.channels }, freshChannel) };
  const states = [state];
  cache.positions = cache.positions || [];
  song.order.forEach((pi, k) => {
    const p = song.patterns[pi], phrases = Array.from({ length: song.channels }, (_, ch) => phraseBytes(song, p, ch));
    const key = JSON.stringify([song.ticksPerRow, phrases.map((b) => b.join(',')), state]);
    const hit = cache.positions[k];
    state = hit && hit.key === key ? hit.end : chasePosition(song, p, phrases, state);
    cache.positions[k] = { key, end: state };
    states.push(state);
  });
  cache.positions.length = song.order.length;
  return states;
}

// The commands that set a channel up as `state` has it. `from` is the state
// the channel may be in already (the end of the position on repeat): its
// sweeps that `state` has not are stopped first.
export function entryBytes(state, ch, from) {
  const c = state.ch[ch], out = [];
  if (!c) return out;
  const swept = new Set();
  for (const w of c.sweeps) { swept.add(w.offset); if (w.word) swept.add(w.offset + 1); }
  if (from && from.ch[ch])
    for (const w of from.ch[ch].sweeps)
      if (!c.sweeps.some((x) => x.offset === w.offset)) out.push(CH.SWEEP, w.offset, 0, 0, 0, 0, 0, 0, 0);
  out.push(CH.INSTRUMENT, c.inst);
  for (const off of Object.keys(c.patch).map(Number).sort((a, b) => a - b))
    if (!swept.has(off)) out.push(CH.PATCH, off, c.patch[off]);
  for (const w of c.sweeps)
    out.push(CH.SWEEP, w.offset, ...u16(w.value), ...s16(w.step), w.low, w.high, w.mode | (w.word ? 0x80 : 0));
  out.push(CH.VOLUME, c.vol, CH.LENGTH, ...u16(c.len), CH.LEGATO, c.legato, CH.FINE, c.fine & 0xFF,
    CH.POSITION, c.x & 0xFF, c.y & 0xFF, CH.VIBRATO, ...c.vib, CH.VOLUME_SLIDE, c.vstep & 0xFF, CH.ARPEGGIO, ...c.arp);
  if (c.start) out.push(CH.SAMPLE_START, ...u16(c.start));
  if (ch === 0) out.push(CH.TEMPO, ...u16(state.bpm));
  return out;
}

// A play from order position k (the tracker's play buttons): the song from
// there, or with `only` that position on repeat, each channel set up first
// as the rows before left it; from its row `row` (a change while it plays).
export function writePlay(song, k, only = false, cache = {}, row = 0) {
  const states = chase(song, cache), start = states[k], end = only ? states[k + 1] : null, n = song.channels;
  const entry = Array.from({ length: n }, (_, ch) => entryBytes(start, ch, end));
  const p = song.patterns[song.order[k]];
  row = Math.max(0, Math.min(p.rows - 1, row | 0));
  let rowEntry = null;
  if (row) {
    const phrases = Array.from({ length: n }, (_, ch) => phraseBytes(song, p, ch));
    const mid = chasePosition(song, p, phrases, start, row * song.ticksPerRow);
    rowEntry = Array.from({ length: n }, (_, ch) => entryBytes(mid, ch));
  }
  return writeSong(song, { from: k, only, entry, row, rowEntry });
}
