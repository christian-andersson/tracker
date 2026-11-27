// SPDX-License-Identifier: GPL-3.0-only
// C64 SID tunes (.sid, PSID and RSID): run on the emulated C64 (c64.js),
// what they write to the SID chip recorded, and that turned into a song.
//
// A SID tune is a program, so the tune itself is never read as music: it
// runs, and only what reaches the SID's registers counts, whoever wrote the
// player and whichever version of it. Each tick (a video frame, or a CIA
// timer period for tunes timed by one) the registers are read as they stand:
// each voice is a channel, a gate going on strikes a note at the nearest
// pitch, pitch changes while it sounds are bends, and each distinct sound
// (waveform, envelope, filter) is an instrument, with what changes during a
// note (pulse width, waveform, filter cutoff) as patches of it. Samples played
// through the volume register ("digis") are rendered to PCM and played on a
// channel of their own. Then the commands are laid on rows like any song
// without tracker data: best effort on the grid the notes fall on, exact on
// one tick a row.

import { CH, INSTRUMENT_SIZE, makeInstrument, msEnv, setField } from './format.js';
import { WAVE_SAMPLE, setU32 } from './waves.js';
import { bestEffort } from './song.js';
import { OP_SAMPLE_NEAREST } from './mod.js';
import { C64, C64_NTSC, C64_PAL } from './c64.js';

export const isSid = (b) => b.length >= 0x7C && ['PSID', 'RSID'].includes(String.fromCharCode(b[0], b[1], b[2], b[3]));

// The header (big-endian) and the tune's bytes.
export function readSidFile(buf) {
  const d = new Uint8Array(buf), dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (!isSid(d)) throw new Error('not a PSID or RSID file');
  const u16 = (o) => dv.getUint16(o), text = (o) => String.fromCharCode(...d.subarray(o, o + 32)).replace(/\0.*$/s, '').trim();
  const version = u16(4), dataOffset = u16(6);
  let load = u16(8), data = d.subarray(dataOffset);
  if (!load) { load = data[0] | data[1] << 8; data = data.subarray(2); }
  const flags = version >= 2 ? u16(0x76) : 0, sids = [0xD400];
  for (const o of [0x7A, 0x7B]) if (version >= 3 && d[o] && d.length > o) {
    const a = 0xD000 | d[o] << 4;
    if (d[o] & 1 || a < 0xD420 || (a >= 0xD800 && a < 0xDE00)) break;   // not a valid address: none from here on
    sids.push(a); if (version < 4) break;
  }
  return { real: d[0] === 0x52, version, load, data, init: u16(0x0A), play: u16(0x0C), songs: Math.max(1, u16(0x0E)),
    start: Math.max(1, u16(0x10)), speed: dv.getUint32(0x12), name: text(0x16), author: text(0x36), released: text(0x56),
    ntsc: ((flags >> 2) & 3) === 2, sids };
}

// ---------------------------------------------------------------- running the tune

export const SID_WINDOW_S = 10, SID_SILENT_S = 3, SID_TAIL_S = 3;   // a loop must repeat this long; silence this long ends it
export const SID_DIGI_WRITES = 8;                     // volume writes in a tick that count as sample playback
export const SID_HOLD_S = 2, SID_HOLD_AFTER_S = 10;     // a repeat this short, starting this late, is the tune's end state, not its loop

// Run `tune` (readSidFile) and record its SID registers tick by tick.
// options: song (1-based), seconds (a fixed length; else up to maxSeconds,
// stopping where it falls silent or starts repeating itself).
export function runSid(tune, options = {}) {
  const song = Math.max(1, Math.min(tune.songs, options.song || tune.start)), nsid = tune.sids.length;
  const ciaTimed = !tune.real && tune.play && (tune.speed >>> Math.min(song - 1, 31)) & 1;
  const regsNow = Array.from({ length: nsid }, () => new Uint8Array(32));
  const voices = nsid * 3, gate = new Uint8Array(voices), rises = new Uint8Array(voices);
  let volWrites = 0, volMax = 0;
  const digiAt = [], digiVal = [];                     // every volume write of the first SID: cycle, value
  const c64 = new C64({ ntsc: tune.ntsc, sids: tune.sids, onSid: (k, r, v, cyc) => {
    regsNow[k][r] = v;
    if (r === 4 || r === 11 || r === 18) {
      const vi = k * 3 + (r - 4) / 7;
      if (v & 1 && !gate[vi]) rises[vi]++;
      gate[vi] = v & 1;
    } else if (r === 0x18 && k === 0) { volWrites++; volMax = Math.max(volMax, v & 15); digiAt.push(cyc); digiVal.push(v); }
  } });
  c64.load(tune.load, tune.data);
  const bank = (addr) => (addr >= 0xE000 || tune.load + tune.data.length > 0xE000 ? 0x35 : 0x37);
  if (!tune.real && tune.play) c64.cia[0].mask = 0;    // a PSID with a play address: no KERNAL timer interrupt
  if (!tune.real) c64.ram[1] = bank(tune.init);
  c64.call(tune.init, song - 1);
  // a tune with a play address returns from init (some unpack themselves first): run it out, within 5 s
  if (tune.play) { const cap = c64.cyc + c64.frameCycles * 250; while (!c64.idle() && c64.cyc < cap && !c64.cpu.jammed) c64.run(c64.cyc + c64.frameCycles); }
  const { clock } = tune.ntsc ? C64_NTSC : C64_PAL;
  const period = () => (ciaTimed ? c64.cia[0].la + 1 : c64.frameCycles);
  const hz = clock / period();
  const fixed = options.seconds ? Math.round(options.seconds * hz) : 0;
  const limit = fixed || Math.round((options.maxSeconds || 600) * hz);
  const stride = 25 * nsid, regs = [], ticks = [], gates = [], keyIds = new Map(), keys = [];
  let inited = false, end = null, start = 0;
  for (let t = 0; t < limit; t++) {
    if (!inited && c64.idle()) inited = true;
    if (inited && tune.play && c64.idle()) { if (!tune.real) c64.ram[1] = bank(tune.play); c64.call(tune.play); }
    rises.fill(0); volWrites = 0; volMax = 0;
    const g0 = Uint8Array.from(gate);
    start = c64.cyc;
    c64.run(start + period());
    const snap = new Uint8Array(stride);
    regsNow.forEach((r, k) => snap.set(r.subarray(0, 25), 25 * k));
    if (volWrites >= SID_DIGI_WRITES) snap[24] = (snap[24] & 0xF0) | volMax;
    regs.push(snap); ticks.push(start);
    gates.push({ before: g0, rises: Uint8Array.from(rises), digi: volWrites >= SID_DIGI_WRITES });
    // the music of the tick, for finding where it repeats: pitch, waveform, envelope and gates, not the
    // pulse widths and filter cutoff (players sweep those on counters of their own) or a sample's volume
    let key = (volWrites >= SID_DIGI_WRITES ? 'd' : snap[24] & 15) + '|' + Array.from(rises).join('');
    for (let k = 0; k < nsid; k++) for (let v = 0; v < 3; v++) { const o = 25 * k + 7 * v; key += `|${snap[o]},${snap[o + 1]},${snap[o + 4]},${snap[o + 5]},${snap[o + 6]}`; }
    if (!keyIds.has(key)) keyIds.set(key, keyIds.size);
    keys.push(keyIds.get(key));
    if (c64.cpu.jammed) break;
    if (!fixed && t > 0 && t % Math.round(30 * hz) === 0) { end = sidEnd(keys, regs, hz, nsid); if (end) break; }
  }
  if (!fixed && !end) end = sidEnd(keys, regs, hz, nsid);
  ticks.push(c64.cyc);
  return { song, ciaTimed, hz, clock, regs, ticks, gates, digiAt, digiVal, end, jammed: c64.cpu.jammed ? c64.cpu.pc : -1, nsid, limit, fixed };
}

// Where the tune ends: { loop, length } where it starts repeating itself
// for good (it loops from tick `loop`, `length` ticks long), or { silent }
// where it falls silent. null if neither shows up.
export function sidEnd(keys, regs, hz, nsid) {
  const n = keys.length, w = Math.round(SID_WINDOW_S * hz), quiet = Math.round(SID_SILENT_S * hz);
  const same = (a, b, len) => { for (let i = 0; i < len; i++) if (keys[a + i] !== keys[b + i]) return false; return true; };
  let silent = -1;
  for (let t = 1, run = 1; t < n; t++) {
    run = keys[t] === keys[t - 1] ? run + 1 : 1;
    let on = false;
    for (let v = 0; v < nsid * 3 && !on; v++) on = (regs[t][25 * Math.floor(v / 3) + (v % 3) * 7 + 4] & 1) === 1;
    if (run >= quiet && !on) { silent = t - quiet + 1; break; }
  }
  const tail = n - w;
  if (tail > w) {
    let p = -1;
    for (let q = tail - w - 1; q >= 0; q--) if (keys[q] === keys[tail] && same(q, tail, w)) { p = q; break; }
    if (p >= 0) {
      let length = tail - p;                         // a whole number of the tune's periods: the shortest that repeats
      for (let d = 1; d < length; d++) if (length % d === 0 && same(tail - length, tail - length + d, length - d)) { length = d; break; }
      for (let t = 0; t + length + w <= n; t++) if (same(t, t + length, w)) {
        if (silent >= 0 && silent <= t) break;
        if (length < SID_HOLD_S * hz && t > SID_HOLD_AFTER_S * hz) return { held: t, length };   // it ended, holding a short repeat
        return { loop: t, length };
      }
    }
  }
  return silent >= 0 ? { silent } : null;
}

// ---------------------------------------------------------------- the song

// SID envelope times, ms: attack, and decay and release (a full fall)
export const SID_ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
export const SID_DECAY_MS = [6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000];
export const SID_OP = 20;                              // the operator that plays (makeInstrument's)
export const SID_WAVE_NAMES = ['', 'Triangle', 'Saw', 'Pulse', 'Noise'];
export const SID_DIGI_RATE = 16000;

// Ticks a second as bpm and ticks per beat.
export function sidTiming(hz) {
  let best = null;
  for (const tpb of [24, 48, 96, 12, 32, 64]) {
    const bpm = Math.max(1, Math.round(hz * 60 / tpb)), err = Math.abs(bpm * tpb / 60 - hz) / hz;
    if (!best || err < best.err - 1e-9) best = { tpb, bpm, err };
  }
  return best;
}

// What a voice sounds like in one tick, as the bytes of an instrument.
function sidSound(r, s, v, clock) {
  const b = 25 * s, o = 7 * v, ctrl = r[b + o + 4], ad = r[b + o + 5], sr = r[b + o + 6];
  const freq = r[b + o] | r[b + o + 1] << 8, pw = (r[b + o + 2] | r[b + o + 3] << 8) & 0xFFF;
  const route = r[b + 0x17], mode = r[b + 0x18], filtered = (route >> v) & 1;
  const waves = (ctrl >> 4) & 7, wave = ctrl & 0x80 ? 4 : ctrl & 0x40 ? 3 : ctrl & 0x20 ? 2 : ctrl & 0x10 ? 1 : 0;
  const fm = (mode >> 4) & 7, fmode = !filtered ? 0 : [0, 1, 3, 1, 2, 4, 2, 3][fm];
  const silent = !wave || ctrl & 8 || !freq || (v === 2 && mode & 0x80 && !filtered) || (filtered && !fm);
  return {
    wave: wave || 1, level: silent ? 0 : waves & (waves - 1) && !(ctrl & 0x80) ? 120 : 200,
    width: wave === 3 ? Math.min(65535, pw * 16) : 0,
    attack: msEnv(SID_ATTACK_MS[ad >> 4]), decay: msEnv(SID_DECAY_MS[ad & 15]), sustain: (sr >> 4) * 17, release: msEnv(SID_DECAY_MS[sr & 15]),
    filter: fmode, cutoff: filtered ? Math.round(((r[b + 0x15] & 7) | r[b + 0x16] << 3) * 255 / 2047) : 255,
    resonance: filtered ? (route >> 4) * 17 : 0, ring: (ctrl & 4) !== 0, sync: (ctrl & 2) !== 0, combined: (waves & (waves - 1)) !== 0,
    midi: freq ? 69 + 12 * Math.log2(freq * clock / 16777216 / 440) : null,
  };
}
// the patchable bytes of an instrument: [offset, value]
const sidBytes = (x) => [[SID_OP, x.wave], [SID_OP + 3, x.level], [SID_OP + 4, x.width & 0xFF], [SID_OP + 5, x.width >> 8],
  [SID_OP + 12, x.attack], [SID_OP + 13, x.decay], [SID_OP + 14, x.sustain], [SID_OP + 15, x.release], [81, x.filter], [82, x.cutoff], [83, x.resonance]];

// The recording (runSid) as a song: best effort, or exact with options.exact.
export function sidSong(tune, rec, options = {}) {
  const { regs, gates, hz, clock, nsid, end } = rec, voices = 3 * nsid;
  let last = regs.length, loopTick = -1;
  if (end && end.loop !== undefined) { loopTick = end.loop; last = Math.min(regs.length, end.loop + end.length); }
  else if (end) last = Math.min(regs.length, (end.silent !== undefined ? end.silent : end.held) + Math.round(SID_TAIL_S * hz));
  const { tpb, bpm } = sidTiming(hz);
  const song = { name: tune.name, auth: tune.author, licn: '', desc: `C64 SID tune${tune.released ? ', ' + tune.released : ''}`, date: '',
    bpm, tpb, channels: voices, voices: Array.from({ length: 16 }, (_, i) => i), instruments: [], waves: [], patterns: [], order: [],
    loop: -1, notes: [], ticksPerRow: 1, rowsPerBeat: 4 };
  const instKey = new Map(), count = { ring: 0, sync: 0, combined: 0 };
  const instrument = (x) => {
    const key = [x.wave, x.level ? (x.level === 200 ? 2 : 1) : 0, x.attack, x.decay, x.sustain, x.release, x.filter, x.resonance].join(',');
    if (!instKey.has(key)) {
      const bytes = makeInstrument({ wave: x.wave });
      for (const [off, v] of sidBytes(x)) bytes[off] = v;
      instKey.set(key, song.instruments.length);
      song.instruments.push({ name: `${SID_WAVE_NAMES[x.wave]}${x.filter ? ' (filtered)' : ''}`, bytes });
    }
    return instKey.get(key);
  };
  const flat = [];
  for (let vi = 0; vi < voices; vi++) {
    const s = Math.floor(vi / 3), v = vi % 3, events = new Map();
    const at = (t) => { if (!events.has(t)) events.set(t, []); return events.get(t); };
    const add = (t, op, ...args) => at(t).push({ op, args: Uint8Array.from(args) });
    let inst = -1, eff = null, note = -1, bend = 0, held = false, vol = -1, offNext = false;
    for (let t = 0; t < last; t++) {
      const r = regs[t], g = gates[t], x = sidSound(r, s, v, clock), gateOn = (r[25 * s + 7 * v + 4] & 1) === 1;
      if (offNext) { add(t, CH.OFF); held = false; offNext = false; }
      const mv = g.digi ? vol : Math.round(255 * (r[25 * s + 0x18] & 15) / 15);
      if (mv !== vol && mv >= 0) { add(t, CH.VOLUME, mv); vol = mv; }
      const strike = g.rises[vi] > 0;
      if (strike) {
        if (held || g.before[vi]) add(t, CH.OFF);
        const k = instrument(x);
        if (k !== inst) { add(t, CH.INSTRUMENT, k); inst = k; eff = Uint8Array.from(song.instruments[k].bytes); }
        if (x.ring) count.ring++; if (x.sync) count.sync++; if (x.combined) count.combined++;
      } else if (held && !gateOn) { add(t, CH.OFF); held = false; }
      if (eff) for (const [off, val] of sidBytes(x)) if (eff[off] !== val) { add(t, CH.PATCH, off, val); eff[off] = val; }
      if (x.midi !== null) {
        if (strike) {
          note = Math.max(0, Math.min(127, Math.round(x.midi)));
          add(t, CH.NOTE, note); held = true; bend = 0;
          if (!gateOn) offNext = true;                 // struck and released within the tick
        }
        if (note >= 0) {
          const c = Math.max(-32768, Math.min(32767, Math.round((x.midi - note) * 100)));
          if (c !== bend) { add(t, CH.BEND, c & 0xFF, (c >> 8) & 0xFF); bend = c; }
        }
      } else if (strike) { note = -1; }
    }
    flat.push({ events, loopTick, endTick: last });
  }
  // samples played through the volume register: runs of ticks with many writes, each run a sample
  const digi = sidDigi(rec, last);
  if (digi.hits.length) {
    const events = new Map(), keyOf = new Map();
    events.set(0, [{ op: CH.VOLUME, args: Uint8Array.of(255) }]);
    let inst = -1;
    for (const h of digi.hits) {
      if (!keyOf.has(h.key)) {
        keyOf.set(h.key, song.instruments.length);
        const w = song.waves.push({ kind: 'sample', name: `digi ${keyOf.size}`, frames: h.pcm.length, loopStart: 0, loopLength: 0,
          rate: SID_DIGI_RATE, root: 60, format: 1, data: h.pcm }) - 1;
        const b = new Uint8Array(INSTRUMENT_SIZE), o = 60;
        b[o] = WAVE_SAMPLE; b[o + 1] = 2; b[o + 3] = 255; b[o + 6] = OP_SAMPLE_NEAREST; b[o + 14] = 255; b[o + 15] = 32;
        setU32(b, o + 16, w); setField(b, 80, 'u8', 7); b[82] = 255;
        song.instruments.push({ name: `Digi ${keyOf.size}`, bytes: b });
      }
      const k = keyOf.get(h.key), cmds = events.get(h.tick) || [];
      if (k !== inst) { cmds.push({ op: CH.INSTRUMENT, args: Uint8Array.of(k) }); inst = k; }
      cmds.push({ op: CH.NOTE, args: Uint8Array.of(60) });
      events.set(h.tick, cmds);
    }
    flat.push({ events, loopTick, endTick: last });
    song.channels = voices + 1;
  }
  const out = bestEffort(song, flat, !!options.exact);
  const seconds = (n) => `${(n / hz).toFixed(1)} s`;
  out.notes.unshift(`A C64 SID tune (${tune.real ? 'RSID' : 'PSID'}, ${tune.ntsc ? 'NTSC' : 'PAL'}${nsid > 1 ? `, ${nsid} SIDs` : ''}), ` +
    `song ${rec.song} of ${tune.songs}, run on an emulated C64 at ${hz.toFixed(2)} ticks a second${rec.ciaTimed ? ' (a CIA timer)' : ''}.`,
  loopTick >= 0 ? `It repeats itself from ${seconds(loopTick)}: looped there, ${seconds(last - loopTick)} long.`
    : end && end.silent !== undefined ? `It falls silent at ${seconds(end.silent)}.`
      : end && end.held !== undefined ? `It ends at ${seconds(end.held)}, repeating ${seconds(end.length)} over and over from there: cut ${SID_TAIL_S} s later.`
      : `Cut at ${seconds(last)}${rec.fixed ? '' : ': it neither repeated itself nor fell silent before then'}.`);
  if (digi.hits.length) out.notes.push(`Samples played through the volume register: ${digi.hits.length} on channel ${voices + 1}, ` +
    `${new Set(digi.hits.map((h) => h.key)).size} different.`);
  out.lost = ['The song is rebuilt from what the tune wrote to the SID chip: its notes, instruments and patterns are worked out ' +
    'from the sound, not read from the tune, so the patterns are not laid out as the composer wrote them.'];
  if (count.ring || count.sync) out.lost.push(`Ring modulation and hard sync between voices are not carried over (${count.ring + count.sync} notes): those notes sound plainer.`);
  if (count.combined) out.lost.push(`Combined waveforms play as one waveform, quieter (${count.combined} notes).`);
  if (rec.jammed >= 0) out.lost.push(`The tune stopped the processor (a JAM opcode at $${rec.jammed.toString(16).toUpperCase().padStart(4, '0')}); the song ends there.`);
  return out;
}

// The volume-register samples: each run of ticks with sample playback
// (gaps of up to two ticks bridged) rendered as 8-bit PCM from the start of
// its first tick, so it starts on time. Equal runs (the same values
// written) share a sample.
export function sidDigi(rec, last) {
  const { gates, ticks, digiAt, digiVal, clock } = rec, hits = [];
  let i = 0;
  for (let t = 0; t < last; t++) {
    if (!gates[t].digi) continue;
    let e = t;
    while (e + 1 < last && (gates[e + 1].digi || (e + 2 < last && gates[e + 2].digi) || (e + 3 < last && gates[e + 3].digi))) e++;
    const c0 = ticks[t], c1 = ticks[e + 1];
    while (i < digiAt.length && digiAt[i] < c0) i++;
    let level = i > 0 ? digiVal[i - 1] & 15 : 15, j = i;
    const n = Math.max(1, Math.round((c1 - c0) * SID_DIGI_RATE / clock)), step = (c1 - c0) / n, pcm = new Float64Array(n), vals = [];
    for (let k = 0; k < n; k++) {
      const stop = c0 + (k + 1) * step;
      let acc = 0, pos = c0 + k * step;
      while (j < digiAt.length && digiAt[j] < stop) {
        if (digiAt[j] > pos) { acc += level * (digiAt[j] - pos); pos = digiAt[j]; }
        level = digiVal[j] & 15; vals.push(level); j++;
      }
      pcm[k] = (acc + level * (stop - pos)) / step;
    }
    const mean = pcm.reduce((a, b) => a + b, 0) / n, data = new Uint8Array(n);
    for (let k = 0; k < n; k++) data[k] = Math.max(-128, Math.min(127, Math.round((pcm[k] - mean) / 15 * 254))) & 0xFF;
    // the values written, repeats run together: the same drum gives the same key wherever its first write falls
    hits.push({ tick: t, pcm: data, key: vals.filter((x, k) => k === 0 || x !== vals[k - 1]).join(',') });
    i = j; t = e;
  }
  return { hits };
}

// A SID tune as a song. options: song (1-based), seconds, maxSeconds, exact.
export function readSid(buf, options = {}) {
  const tune = readSidFile(buf);
  return sidSong(tune, runSid(tune, options), options);
}
