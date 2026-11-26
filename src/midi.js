// SPDX-License-Identifier: GPL-3.0-only
// Standard MIDI Files (.mid): parts spread over song channels, on the
// General MIDI instruments of a bank.

import { CH } from './format.js';
import { bestEffort, u16 } from './song.js';
import { BANK_NOTICE, pyRound } from './wopl.js';

// ---------------------------------------------------------------- Standard MIDI Files (.mid)

// A MIDI file: its notes read and spread over song channels (a part gets as
// many channels as it has notes sounding at once, MIDI channel 10 a
// channel per kind of drum; at most 16), each part on its General MIDI
// instrument from a WOPL bank (gmBank). The command-line converter
// (converters/midi2rsng.js) and the tracker both read MIDI
// with this.
export const NAME_PROGRAM = [['sub', 39], ['bass', 33], ['chord', 88], ['pad', 88], ['string', 48], ['choir', 52], ['lead', 80], ['melod', 80],
  ['solo', 80], ['arp', 24], ['pluck', 24], ['guitar', 24], ['organ', 16], ['bell', 14], ['brass', 61], ['horn', 60], ['flute', 73],
  ['piano', 0], ['key', 0], ['ep', 4]];
export const DRUM_GROUPS = ['kick', 'snare', 'hat', 'tom', 'cymbal', 'perc'];
export function drumGroup(n) {
  if (n === 35 || n === 36) return 'kick';
  if (n >= 37 && n <= 40) return 'snare';
  if ([42, 44, 46].includes(n)) return 'hat';
  if ([41, 43, 45, 47, 48, 50].includes(n)) return 'tom';
  if (n < 35 || [49, 51, 52, 53, 55, 57, 59].includes(n)) return 'cymbal';
  return 'perc';
}
// a melodic part's program: its program change, else what its track name
// says, else 0. A program 0 gives way to the name: some generators (AIVA)
// leave every track on 0 and say what it is in its name.
export function programFor(tr, div) {
  if (tr.program) return tr.program;
  const name = tr.name.toLowerCase(), hit = NAME_PROGRAM.find(([w]) => name.includes(w));
  if (!hit) return 0;
  if (hit[0] !== 'bass') return hit[1];
  const pitches = tr.notes.map((n) => n.note).sort((x, y) => x - y), lens = tr.notes.map((n) => n.end - n.start).sort((x, y) => x - y);
  const low = pitches[pitches.length >> 1] < 40, short = lens[lens.length >> 1] < Math.floor(div / 2);
  return low ? 39 : name.includes('sus') ? 33 : short || name.includes('stac') ? 38 : 33;
}
// channel volume (CC 7) times expression (CC 11), from 127 each: [[tick, level 0-1]]
export function midiLevels(changes) {
  let vol = 127, expr = 127;
  const out = [[0, 1]];
  for (const [tick, cc, v] of [...changes].sort((x, y) => x[0] - y[0])) {
    if (cc === 7) vol = v; else expr = v;
    const level = vol * expr / (127 * 127);
    if (out[out.length - 1][0] === tick) out[out.length - 1] = [tick, level];
    else if (out[out.length - 1][1] !== level) out.push([tick, level]);
  }
  return out;
}
export const levelAt = (levels, tick) => { let v = 1; for (const [t, lv] of levels) { if (t > tick) break; v = lv; } return v; };

export function readMidiFile(buf) {
  const d = new Uint8Array(buf), str = (a, n) => String.fromCharCode(...d.subarray(a, a + n));
  const u32 = (o) => (d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3]) >>> 0, u16b = (o) => d[o] << 8 | d[o + 1];
  if (str(0, 4) !== 'MThd') throw new Error('not a Standard MIDI File');
  const fmt = u16b(8), ntr = u16b(10), div = u16b(12);
  if (div & 0x8000) throw new Error('SMPTE time division is not supported');
  if (fmt === 2) throw new Error('type 2 MIDI files (independent patterns) are not supported');
  let p = 8 + u32(4);
  const tracks = [], tempos = [], ignored = {}, note = (k) => { ignored[k] = (ignored[k] || 0) + 1; };
  for (let tr = 0; tr < ntr; tr++) {
    if (str(p, 4) !== 'MTrk') throw new Error('track chunk missing at byte ' + p);
    let q = p + 8;
    const end = Math.min(d.length, p + 8 + u32(p + 4));
    p = p + 8 + u32(p + 4);
    let tick = 0, status = 0, name = '';
    const byChan = new Map(), held = new Map();
    const chan = (c) => { if (!byChan.has(c)) byChan.set(c, { notes: [], program: null, pan: null, level: [] }); return byChan.get(c); };
    const vlq = () => { let v = 0; for (;;) { const b = d[q++]; v = v * 128 + (b & 127); if (b < 128 || q >= end) return v; } };
    while (q < end) {
      tick += vlq();
      const b = d[q];
      if (b === 0xFF) {
        const kind = d[q + 1]; q += 2;
        const n = vlq(), data = d.subarray(q, q + n); q += n;
        if (kind === 0x03 && !name) name = new TextDecoder('latin1').decode(data).trim();
        else if (kind === 0x51) tempos.push([tick, 60e6 / data.reduce((v, x) => v * 256 + x, 0)]);
        else if (kind === 0x2F) break;
        continue;
      }
      if (b === 0xF0 || b === 0xF7) { q++; q += vlq(); continue; }
      if (b & 0x80) { status = b; q++; }
      const kind = status >> 4, ch = status & 15, size = kind === 0xC || kind === 0xD ? 1 : 2, a = [d[q], d[q + 1]];
      q += size;
      const c = chan(ch), key = ch * 128 + a[0];
      if (kind === 0x9 && a[1]) {
        if (held.has(key)) { held.get(key).end = tick; held.delete(key); }   // struck again while on: the old one ends
        const n = { start: tick, end: null, note: a[0], vel: a[1] };
        c.notes.push(n); held.set(key, n);
      } else if (kind === 0x8 || kind === 0x9) {
        const n = held.get(key);
        if (n) { n.end = tick; held.delete(key); }
      } else if (kind === 0xC) c.program = a[0];
      else if (kind === 0xB && a[0] === 10) { if (c.pan === null) c.pan = a[1]; else note('pan changes'); }
      else if (kind === 0xB && (a[0] === 7 || a[0] === 11)) c.level.push([tick, a[0], a[1]]);
      else if (kind === 0xB && a[0] === 64) note('sustain pedal');
      else if (kind === 0xE) note('pitch bend');
    }
    for (const n of held.values()) n.end = tick;
    for (const [ch, c] of [...byChan].sort((x, y) => x[0] - y[0])) {
      const notes = c.notes.filter((n) => n.end !== null && n.end >= n.start);
      if (notes.length) tracks.push({ index: tracks.length, name, channel: ch, program: c.program, pan: c.pan, notes, level: midiLevels(c.level) });
    }
  }
  tempos.sort((x, y) => x[0] - y[0]);
  if (!tempos.length || tempos[0][0] > 0) tempos.unshift([0, 120]);
  return { div, tracks, tempos, ignored };
}

// Notes over as few one-note channels as possible.
export function allocate(notes, monoEnd) {
  const chans = [];
  for (const n of [...notes].sort((x, y) => x.start - y.start || y.note - x.note)) {
    const c = chans.find((x) => x.busy <= n.start);
    if (c) { c.notes.push(n); c.busy = monoEnd(n); } else chans.push({ notes: [n], busy: monoEnd(n) });
  }
  return chans.map((c) => c.notes);
}

// A MIDI file as channels of commands by tick, and what was left out.
// options: bank (gmBank), patch { track: program | 'drums' }, drop [track].
export function midiChannels(buf, bank, options = {}) {
  const { div, tracks, tempos, ignored } = readMidiFile(buf);
  if (!tracks.length) throw new Error('no notes');
  const msgs = [], lost = [], parts = [], seen = new Map(), overrides = options.patch || {}, drops = new Set(options.drop || []);
  for (const tr of tracks) {
    const key = tr.notes.map((n) => n.start + ':' + n.note).join(','), label = `${tr.index}: ${tr.name || '(no name)'} (ch ${tr.channel + 1})`;
    if (drops.has(tr.index)) { msgs.push(`dropped ${label} (--drop)`); continue; }
    if (seen.has(key)) { msgs.push(`dropped ${label}: same notes as part ${seen.get(key)}`); continue; }
    seen.set(key, tr.index);
    const forced = overrides[tr.index], drums = (forced === undefined && tr.channel === 9) || forced === 'drums';
    if (drums) {
      const groups = new Map();
      let silent = 0;
      for (const n of tr.notes) {
        if (!bank.drums[n.note]) { silent++; continue; }
        const [inst, play] = bank.drums[n.note], g = drumGroup(n.note);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(Object.assign({}, n, { inst, play, drum: true }));
      }
      if (silent) { msgs.push(`dropped ${silent} notes of ${label}: drums the kit has no sound for`); lost.push(`Part ${label}: ${silent} drum notes the kit has no sound for.`); }
      for (const g of DRUM_GROUPS) if (groups.has(g))
        parts.push({ label: `${label} ${g}`, track: tr, channels: allocate(groups.get(g), (n) => n.start + 1),
          insts: [...new Set(groups.get(g).map((n) => n.inst))].sort((x, y) => x - y), drums: true });
    } else {
      const prog = forced !== undefined ? forced : programFor(tr, div), k = bank.keyOffset[prog];
      const notes = tr.notes.map((n) => Object.assign({}, n, { inst: prog, play: Math.max(0, Math.min(127, n.note + k)), drum: false }));
      parts.push({ label, track: tr, channels: allocate(notes, (n) => n.end), insts: [prog], drums: false });
    }
  }
  const over = new Map();                             // part label -> [channels, notes] left out
  while (parts.reduce((k, x) => k + x.channels.length, 0) > 16) {
    let best = null;
    for (const pt of parts) for (const c of pt.channels) if (!best || c.length < best[1].length) best = [pt, c];
    best[0].channels.splice(best[0].channels.indexOf(best[1]), 1);
    msgs.push(`dropped ${best[1].length} notes of ${best[0].label}: more than 16 channels`);
    const o = over.get(best[0].label) || [0, 0]; over.set(best[0].label, [o[0] + 1, o[1] + best[1].length]);
    if (!best[0].channels.length) parts.splice(parts.indexOf(best[0]), 1);
  }
  for (const [label, [c, n]] of over)
    lost.push(`Part ${label}: ${n} notes on ${c} channel${c === 1 ? '' : 's'} left out; the song player has 16 channels.`);
  // song ticks: the smallest of 24, 48 or 96 a beat that holds every time exactly
  const times = new Set(tempos.map(([t]) => t));
  for (const tr of tracks) for (const n of tr.notes) { times.add(n.start); times.add(n.end); }
  let tpb = [24, 48, 96].find((x) => [...times].every((t) => t * x % div === 0)), rounded = false;
  if (!tpb) { tpb = 96; rounded = true; }
  const toTick = (mt) => pyRound(mt * tpb / div);
  const volume = (vel, inst, level) => Math.max(1, Math.min(255, pyRound(255 * Math.max(1, Math.min(127, vel + bank.velocityOffset[inst])) / 127 * level)));
  const chans = parts.flatMap((pt) => pt.channels.map((c) => [pt, c]));
  let last = 0;
  const flat = chans.map(([pt, notes], ci) => {
    const events = new Map(), add = (t, op, args, front = false) => {
      if (!events.has(t)) events.set(t, []);
      events.get(t)[front ? 'unshift' : 'push']({ op, args: Uint8Array.from(args) });
    };
    if (ci === 0) for (const [mt, bpm] of tempos.slice(1)) add(toTick(mt), CH.TEMPO, u16(pyRound(bpm)));
    const pan = pt.track.pan, x = pan === null ? 0 : Math.max(-128, Math.min(127, (pan - 64) * 2));
    add(0, CH.POSITION, [x & 0xFF, 96]);
    const starts = new Set(notes.map((n) => toTick(n.start))), offs = [];
    let inst = null, vol = null;
    notes.forEach((n, k) => {
      const s = toTick(n.start), lv = pt.track.level, v = volume(n.vel, n.inst, levelAt(lv, n.start));
      if (n.inst !== inst) { add(s, CH.INSTRUMENT, [n.inst]); inst = n.inst; }
      if (v !== vol) { add(s, CH.VOLUME, [v]); vol = v; }
      add(s, CH.NOTE, [n.play]);
      const e = Math.max(s + 1, toTick(n.end)), nxt = k + 1 < notes.length ? toTick(notes[k + 1].start) : null;
      if (!(n.drum && nxt !== null && nxt <= e)) { if (!offs.includes(e)) offs.push(e); }   // a drum struck again before it ends: no release
      for (const [mt, level] of lv) {    // the channel's level changing while the note sounds
        const t = toTick(mt);
        if (s < t && t < (nxt !== null && nxt < e ? nxt : e)) { vol = volume(n.vel, n.inst, level); add(t, CH.VOLUME, [vol]); }
      }
      last = Math.max(last, toTick(n.end));
    });
    for (const e of offs) if (!starts.has(e)) add(e, CH.OFF, [], true);
    return { events, loopTick: -1, endTick: 0 };
  });
  for (const f of flat) f.endTick = last + 1;
  return { div, tpb, rounded, bpm: tempos[0][1], tempos, tracks, parts, chans, flat, msgs, lost, ignored };
}

export function readMidi(buf, options = {}) {
  const bank = options.bank;
  if (!bank) throw new Error('no instrument bank for MIDI files');
  const m = midiChannels(buf, bank, options);
  const song = { name: '', auth: '', licn: BANK_NOTICE, desc: 'Standard MIDI File', date: '', bpm: pyRound(m.bpm), tpb: m.tpb,
    channels: m.chans.length, voices: Array.from({ length: 16 }, (_, i) => (i < m.chans.length ? i : 0)),
    instruments: bank.instruments.map((i) => ({ name: i.name, bytes: i.bytes.slice() })), waves: [], patterns: [], order: [], loop: -1,
    notes: [], ticksPerRow: 6, rowsPerBeat: 4 };
  const out = bestEffort(song, m.flat, !!options.exact);
  out.notes.unshift(`${m.tracks.length} MIDI part${m.tracks.length === 1 ? '' : 's'} on ${m.chans.length} channels, ${m.tpb} ticks a beat` +
    `${m.rounded ? ' (times rounded)' : ''}; instruments: the 128 General MIDI programs, then the drums.`);
  out.notes.push(...m.msgs.map((x) => x[0].toUpperCase() + x.slice(1) + '.'));
  const ign = Object.entries(m.ignored);
  if (ign.length) out.notes.push('Not carried over: ' + ign.map(([k, n]) => `${k} ×${n}`).join(', ') + '.');
  out.parts = m.parts;
  out.lost = m.lost;
  return out;
}
export const isMidi = (bytes) => bytes.length >= 14 && String.fromCharCode(...bytes.subarray(0, 4)) === 'MThd';

// Only the instruments a song uses, in their order, its commands renumbered
// (the converters write songs this way; the tracker keeps the whole bank).
export function keepUsedInstruments(song) {
  const used = new Set();
  for (const p of song.patterns) for (const col of p.cells) for (const c of col) {
    if (!c) continue;
    if (c.inst !== null) used.add(c.inst);
    for (const r of [...c.raw, ...(c.post || [])]) if (r[0] === CH.INSTRUMENT) used.add(r[1]);
  }
  const keep = [...used].filter((i) => i < song.instruments.length).sort((x, y) => x - y), map = new Map(keep.map((i, k) => [i, k]));
  song.instruments = keep.map((i) => song.instruments[i]);
  for (const p of song.patterns) for (const col of p.cells) for (const c of col) {
    if (!c) continue;
    if (c.inst !== null) c.inst = map.get(c.inst);
    for (const r of [...c.raw, ...(c.post || [])]) if (r[0] === CH.INSTRUMENT) r[1] = map.get(r[1]);
  }
  return song;
}
